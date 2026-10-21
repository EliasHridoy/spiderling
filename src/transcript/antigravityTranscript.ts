import * as path from 'path';
import { ActivityEvent } from '../types';
import {
  CAPTION_MAX, EventBuilder, ParsedRecord, RecordParser, Rec, isObj, num, oneLine, str,
} from './common';
import { shellEvents } from './shell';

// Reads one Antigravity CLI conversation log
// (`~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript_full.jsonl`).
// One JSON object per step: `{step_index, source, type, status, created_at, ...}`.
//   - PLANNER_RESPONSE: the model's turn; carries `tool_calls: [{name, args}]`,
//     token counts, and sometimes prose in `content`;
//   - GENERIC: a tool's result, as plain text ("Created At … Command exited with
//     code 0. Output: …"). Results carry no call id, and parallel calls finish in
//     any order, so a result is only matched when a turn made a single call;
//   - USER_INPUT / SYSTEM_MESSAGE / ERROR_MESSAGE / CHECKPOINT: not shown.
// Events are therefore built from the call arguments (path, line range, query,
// command) and enriched with the result when it can be matched. The format is
// undocumented, so everything is read defensively. No `vscode` import.

interface Call {
  name: string;
  args: Rec;
  index: number;
}

interface Waiting {
  call: Call;
  step: number;
  ts: string;
  caption?: string;
}

// Single-call turns of these tools wait for their result: it holds the exit
// code, the search hits or the line range actually shown.
const WAIT_FOR_RESULT = new Set(['run_command', 'run_bash', 'find_by_name', 'view_file', 'read_file']);

export class AntigravityTranscriptParser implements RecordParser {
  private readonly b: EventBuilder;
  private waiting?: Waiting;

  constructor(private readonly root: string, session: string) {
    this.b = new EventBuilder(root, session, 'antigravity', '');
  }

  feed(rec: unknown): ParsedRecord | null {
    if (!isObj(rec)) {
      return null;
    }
    const ts = str(rec.created_at) || new Date().toISOString();
    const out: ParsedRecord = { ts, events: [], meta: [] };
    const type = str(rec.type);
    const step = num(rec.step_index) ?? 0;

    if (type === 'GENERIC') {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        out.events.push(...this.callEvents(w.call, w.step, w.ts, w.caption, str(rec.content), out));
      }
      return out;
    }

    // Anything else means a result we were waiting for is not coming.
    this.flush(out);

    if (type === 'PLANNER_RESPONSE') {
      const input = num(rec.input_tokens);
      const output = num(rec.output_tokens);
      if (input !== undefined || output !== undefined) {
        out.usage = {
          messageId: `${this.b.session}:${step}`,
          model: 'antigravity',
          input: input ?? 0,
          output: output ?? 0,
          cacheRead: num(rec.cache_read_tokens) ?? 0,
          cacheCreate: 0,
        };
      }
      const calls: Call[] = (Array.isArray(rec.tool_calls) ? rec.tool_calls : [])
        .filter(isObj)
        .map((tc, index) => ({ name: str(tc.name), args: isObj(tc.args) ? tc.args : {}, index }));
      const prose = str(rec.content).trim() ? oneLine(str(rec.content), CAPTION_MAX) : '';
      for (const call of calls) {
        // The tool call's own one-line summary says why when the model wrote no prose.
        const caption = prose || (str(call.args.toolSummary) ? oneLine(str(call.args.toolSummary), CAPTION_MAX) : undefined);
        if (calls.length === 1 && WAIT_FOR_RESULT.has(call.name)) {
          this.waiting = { call, step, ts, caption };
        } else {
          out.events.push(...this.callEvents(call, step, ts, caption, undefined, out));
        }
      }
    }
    return out;
  }

  private flush(out: ParsedRecord): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      out.events.push(...this.callEvents(w.call, w.step, w.ts, w.caption, undefined, out));
    }
  }

  private callEvents(call: Call, step: number, ts: string, caption: string | undefined, result: string | undefined, out: ParsedRecord): ActivityEvent[] {
    const id = `${step}:${call.index}`;
    const a = call.args;
    const abs = (p: string) => (p ? path.resolve(this.root, p) : '');
    const events: ActivityEvent[] = [];
    const write = (file: string, detail: string, start?: number, end?: number, lines?: number) => {
      const f = abs(file);
      if (f && !this.b.isNoise(f)) {
        const ev = this.b.base('write', call.name, f, id, ts);
        ev.startLine = start;
        ev.endLine = end;
        ev.lines = lines;
        ev.detail = detail;
        events.push(ev);
      }
    };
    const lineCount = (t: string) => (t ? t.split(/\r?\n/).length : 0);

    switch (call.name) {
      case 'view_file':
      case 'read_file': {
        const f = abs(str(a.AbsolutePath) || str(a.Path));
        if (!f || this.b.isNoise(f)) {
          break;
        }
        const ev = this.b.base('read', call.name, f, id, ts);
        let start = num(a.StartLine);
        let end = num(a.EndLine);
        const shown = result ? /Showing lines (\d+) to (\d+)/.exec(result) : null;
        if (shown && (start === undefined || end === undefined)) {
          start = Number(shown[1]);
          end = Number(shown[2]);
        }
        if (start !== undefined && end !== undefined && end >= start) {
          ev.startLine = start;
          ev.endLine = end;
          ev.lines = end - start + 1;
          ev.detail = `read lines ${start}-${end}`;
        } else {
          ev.detail = 'read whole file';
        }
        events.push(ev);
        break;
      }
      case 'replace_file_content': {
        const start = num(a.StartLine);
        const n = lineCount(str(a.ReplacementContent));
        write(str(a.TargetFile) || str(a.File), `edited ${n} line(s)${start ? ` @ line ${start}` : ''}`, start, start !== undefined ? start + Math.max(0, n - 1) : undefined, n);
        break;
      }
      case 'multi_replace_file_content': {
        const chunks = Array.isArray(a.ReplacementChunks) ? a.ReplacementChunks.filter(isObj) : [];
        let start: number | undefined;
        let end: number | undefined;
        let lines = 0;
        for (const c of chunks) {
          const s = num(c.StartLine);
          const n = lineCount(str(c.ReplacementContent));
          lines += n;
          if (s !== undefined) {
            start = start === undefined ? s : Math.min(start, s);
            end = Math.max(end ?? 0, s + Math.max(0, n - 1));
          }
        }
        write(str(a.TargetFile), `${chunks.length} edit(s), ${lines} line(s)`, start, end, lines);
        break;
      }
      case 'edit_file':
        write(str(a.Path), 'edited');
        break;
      case 'write_to_file':
      case 'write_file': {
        const n = lineCount(str(a.CodeContent) || str(a.Content));
        write(str(a.TargetFile) || str(a.Path), a.Overwrite === true ? `rewrote (${n} lines)` : `created (${n} lines)`, 1, n, n);
        break;
      }
      case 'run_command':
      case 'run_bash': {
        const command = str(a.CommandLine) || str(a.Command);
        if (!command) {
          break;
        }
        const cwd = str(a.Cwd) || this.root;
        const exit = result ? /exited with code (-?\d+)/.exec(result) : null;
        const body = result ? result.split(/\n?Output:\r?\n/).slice(1).join('\nOutput:\n') : '';
        const failed = !!exit && exit[1] !== '0';
        if (failed) {
          out.meta.push({ kind: 'toolError', tool: 'shell' });
        }
        events.push(...shellEvents(this.b, [{ command, cwd }], body, failed, id, ts, str(a.toolSummary)));
        break;
      }
      case 'grep_search': {
        const root = abs(str(a.SearchPath) || '.');
        if (this.b.isNoise(root)) {
          break;
        }
        const q = str(a.Query);
        events.push(this.b.search('grep_search', root, q, undefined, id, ts, `grep "${q.slice(0, 48)}"`));
        break;
      }
      case 'find_by_name': {
        const root = abs(str(a.SearchDirectory) || '.');
        if (this.b.isNoise(root)) {
          break;
        }
        const q = str(a.Pattern);
        let hits;
        if (result !== undefined) {
          hits = /No results found/.test(result)
            ? []
            : result.split(/\r?\n/).slice(3).filter((l) => l && !l.startsWith('Found ')).map((l) => ({ file: path.resolve(root, l.trim()) }));
        }
        events.push(this.b.search('find_by_name', root, q, hits, id, ts, `find ${q.slice(0, 48)}`));
        break;
      }
      case 'list_dir': {
        const root = abs(str(a.DirectoryPath));
        if (root && !this.b.isNoise(root)) {
          events.push(this.b.search('list_dir', root, '', undefined, id, ts, 'ls'));
        }
        break;
      }
      case 'call_mcp_tool': {
        const tool = str(a.ToolName) || str(a.tool_name);
        const args = isObj(a.Arguments) ? a.Arguments : isObj(a.arguments) ? a.arguments : {};
        if (tool === 'codegraph_explore') {
          const q = str(args.query);
          events.push(this.b.search('codegraph_explore', this.root, q, undefined, id, ts, `codegraph "${q.slice(0, 48)}"`));
        }
        break;
      }
      case 'invoke_subagent': {
        for (const s of Array.isArray(a.Subagents) ? a.Subagents.filter(isObj) : []) {
          out.meta.push({ kind: 'spawn', spawn: { toolUseId: id, agentType: str(s.TypeName) || 'subagent', description: str(s.Role) } });
        }
        break;
      }
      default:
        break;
    }
    if (events.length && caption) {
      events[0].caption = caption;
    }
    return events;
  }
}
