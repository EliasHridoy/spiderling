import * as path from 'path';
import { ActivityEvent } from '../types';
import {
  CAPTION_MAX, EventBuilder, ParsedRecord, RecordParser, Rec, isObj, num, oneLine, str, unifiedDiffRange,
} from './common';
import { ShellCommand, shellEvents } from './shell';

// Reads one Codex CLI rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
// Every record is `{timestamp, type, payload}`. What it carries, as observed in
// Codex 0.14x-0.16x rollouts:
//   - shell commands: `function_call` `exec_command {cmd, workdir}`, or the
//     `exec` custom tool, a JS snippet calling `tools.exec_command({cmd: "…"})`;
//     the matching `*_output` record holds "Process exited with code N … Output:";
//   - edits: the `apply_patch` custom tool (a `*** Update File:` envelope) and,
//     with exact line numbers, the `patch_apply_end` event (a unified diff per file);
//   - the agent's words: `agent_message` events / assistant `message` items;
//   - tokens: `token_usage_record`; the model comes from `turn_context`.
// The format is undocumented and moves between versions, so everything is read
// defensively and unknown records are skipped. No `vscode` import.

interface Pending {
  kind: 'shell' | 'patch' | 'search';
  cmds?: ShellCommand[];
  files?: string[]; // paths named in the apply_patch envelope
  query?: string;
  projectPath?: string;
  caption?: string;
  done?: boolean;
}

// The text of a quoted JS string literal (double, single or template), or undefined.
function jsString(src: string): string | undefined {
  const q = src[0];
  if (q === '"') {
    try {
      return JSON.parse(src);
    } catch {
      return undefined;
    }
  }
  if (q === "'" || q === '`') {
    const body = src.slice(1, -1);
    if (q === '`' && body.includes('${')) {
      return undefined; // interpolated: not a fixed command
    }
    return body.replace(/\\(.)/g, (_m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  return undefined;
}

const STRING_LITERAL = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` + '`(?:[^`\\\\]|\\\\.)*`)';

// The `exec` tool wraps calls like `await tools.exec_command({cmd:"...", workdir:"..."})`.
export function execCommands(source: string): { cmd: string; workdir?: string }[] {
  const out: { cmd: string; workdir?: string }[] = [];
  const re = new RegExp(`exec_command\\(\\s*\\{([^}]*?)\\}\\s*\\)`, 'gs');
  for (const m of source.matchAll(re)) {
    const body = m[1];
    const cmd = new RegExp(`\\bcmd\\s*:\\s*${STRING_LITERAL}`, 's').exec(body);
    const wd = new RegExp(`\\bworkdir\\s*:\\s*${STRING_LITERAL}`, 's').exec(body);
    const c = cmd && jsString(cmd[1]);
    if (c) {
      out.push({ cmd: c, workdir: (wd && jsString(wd[1])) || undefined });
    }
  }
  return out;
}

// Files named in an apply_patch envelope.
export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    files.push(m[1].trim());
  }
  return files;
}

export class CodexTranscriptParser implements RecordParser {
  private readonly pending = new Map<string, Pending>();
  private readonly b: EventBuilder;
  private cwd: string;
  private model = '';
  private lastText = '';
  private contextSent = false;

  constructor(root: string, session: string) {
    this.b = new EventBuilder(root, session, 'codex', '');
    this.cwd = root;
  }

  feed(rec: unknown): ParsedRecord | null {
    if (!isObj(rec)) {
      return null;
    }
    const ts = str(rec.timestamp) || new Date().toISOString();
    const out: ParsedRecord = { ts, events: [], meta: [] };
    const payload = isObj(rec.payload) ? rec.payload : {};

    switch (str(rec.type)) {
      case 'session_meta': {
        if (str(payload.cwd)) {
          this.cwd = str(payload.cwd);
        }
        if (!this.contextSent) {
          this.contextSent = true;
          const git = isObj(payload.git) ? payload.git : {};
          out.meta.push({ kind: 'context', cwd: this.cwd, gitBranch: str(git.branch) });
        }
        break;
      }
      case 'turn_context': {
        this.model = str(payload.model) || this.model;
        this.cwd = str(payload.cwd) || this.cwd;
        break;
      }
      case 'token_usage_record': {
        const u = isObj(payload.usage) ? payload.usage : undefined;
        if (u) {
          const cached = num(u.cached_input_tokens) ?? 0;
          out.usage = {
            messageId: str(payload.response_id) || `${ts}`,
            model: this.model || 'codex',
            input: Math.max(0, (num(u.input_tokens) ?? 0) - cached), // Codex counts cached tokens inside input
            output: num(u.output_tokens) ?? 0,
            cacheRead: cached,
            cacheCreate: num(u.cache_write_input_tokens) ?? 0,
          };
        }
        break;
      }
      case 'response_item':
        this.onItem(payload, out, ts);
        break;
      case 'event_msg':
        this.onEvent(payload, out, ts);
        break;
      default:
        break;
    }
    return out;
  }

  private caption(): string | undefined {
    const c = this.lastText;
    this.lastText = '';
    return c || undefined;
  }

  private onItem(p: Rec, out: ParsedRecord, ts: string): void {
    const type = str(p.type);
    const id = str(p.call_id);

    if (type === 'message' && str(p.role) === 'assistant' && Array.isArray(p.content)) {
      const t = p.content.map((c) => (isObj(c) ? str(c.text) : '')).join(' ').trim();
      if (t) {
        this.lastText = oneLine(t, CAPTION_MAX);
      }
    } else if (type === 'function_call' && id) {
      const name = str(p.name);
      let args: Rec = {};
      try {
        const parsed = JSON.parse(str(p.arguments));
        args = isObj(parsed) ? parsed : {};
      } catch {
        // malformed arguments: treat as empty
      }
      if (name === 'exec_command' && str(args.cmd)) {
        this.pending.set(id, { kind: 'shell', cmds: [{ command: str(args.cmd), cwd: str(args.workdir) || this.cwd }], caption: this.caption() });
      } else if (name === 'codegraph_explore') {
        this.pending.set(id, { kind: 'search', query: str(args.query), projectPath: str(args.projectPath), caption: this.caption() });
      }
    } else if (type === 'custom_tool_call' && id) {
      const name = str(p.name);
      const input = str(p.input);
      if (name === 'exec') {
        const cmds = execCommands(input).map((c) => ({ command: c.cmd, cwd: c.workdir || this.cwd }));
        if (cmds.length) {
          this.pending.set(id, { kind: 'shell', cmds, caption: this.caption() });
        }
      } else if (name === 'apply_patch') {
        this.pending.set(id, { kind: 'patch', files: patchFiles(input), caption: this.caption() });
      }
    } else if ((type === 'function_call_output' || type === 'custom_tool_call_output') && id) {
      this.onOutput(id, outputText(p.output), out, ts);
    }
  }

  private onOutput(id: string, text: string, out: ParsedRecord, ts: string): void {
    const call = this.pending.get(id);
    if (!call) {
      return;
    }
    this.pending.delete(id);
    const events: ActivityEvent[] = [];
    if (call.kind === 'shell' && call.cmds) {
      const exit = /(?:Process exited with code|Exit code:)\s*(-?\d+)/.exec(text);
      const body = text.split(/\n?Output:\r?\n/).slice(1).join('\nOutput:\n') || text;
      const failed = !!exit && exit[1] !== '0';
      if (failed) {
        out.meta.push({ kind: 'toolError', tool: 'shell' });
      }
      events.push(...shellEvents(this.b, call.cmds, body, failed, id, ts));
    } else if (call.kind === 'search') {
      const root = this.b.abs(this.cwd, call.projectPath || '.');
      if (!this.b.isNoise(root)) {
        events.push(this.b.search('codegraph_explore', root, call.query ?? '', undefined, id, ts, `codegraph "${(call.query ?? '').slice(0, 48)}"`));
      }
    } else if (call.kind === 'patch' && !call.done && /^Success/m.test(text)) {
      // patch_apply_end normally arrives first and carries line numbers; this is
      // the fallback for a log that lacks it.
      for (const f of call.files ?? []) {
        const abs = this.b.abs(this.cwd, f);
        if (!this.b.isNoise(abs)) {
          const ev = this.b.base('write', 'apply_patch', abs, id, ts);
          ev.detail = 'patched';
          events.push(ev);
        }
      }
    }
    if (events.length && call.caption) {
      events[0].caption = call.caption;
    }
    out.events.push(...events);
  }

  private onEvent(p: Rec, out: ParsedRecord, ts: string): void {
    const type = str(p.type);
    if (type === 'agent_message' && str(p.message)) {
      this.lastText = oneLine(str(p.message), CAPTION_MAX);
    } else if (type === 'patch_apply_end') {
      const id = str(p.call_id);
      const call = this.pending.get(id);
      if (p.success === false || !isObj(p.changes)) {
        return;
      }
      const events: ActivityEvent[] = [];
      for (const [file, raw] of Object.entries(p.changes)) {
        const ch = isObj(raw) ? raw : {};
        const abs = path.resolve(this.cwd, file);
        if (this.b.isNoise(abs)) {
          continue;
        }
        const ev = this.b.base('write', 'apply_patch', abs, id, ts);
        const kind = str(ch.type);
        if (kind === 'add') {
          const n = str(ch.content).split(/\r?\n/).length;
          ev.startLine = 1;
          ev.endLine = n;
          ev.lines = n;
          ev.detail = `created (${n} lines)`;
        } else if (kind === 'delete') {
          ev.detail = 'deleted';
        } else {
          const r = unifiedDiffRange(str(ch.unified_diff));
          if (r.start !== undefined) {
            ev.startLine = r.start;
            ev.endLine = r.end;
            ev.lines = r.added;
            ev.detail = `patched ${r.added} line(s) @ line ${r.start}`;
          } else {
            ev.detail = 'patched';
          }
        }
        events.push(ev);
      }
      if (call) {
        call.done = true;
        if (events.length && call.caption) {
          events[0].caption = call.caption;
        }
      }
      out.events.push(...events);
    }
  }
}

function outputText(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (isObj(v)) {
    return str(v.output) || str(v.content) || JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return v.map((c) => (isObj(c) ? str(c.text) : str(c))).join('\n');
  }
  return '';
}
