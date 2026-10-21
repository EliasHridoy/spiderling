import * as path from 'path';
import { ActivityEvent, SearchHit } from '../types';
import { parseHits } from './bashParse';
import { shellEvents } from './shell';

// Reads one Claude Code transcript file (the main session `<session>.jsonl` or a
// subagent's `subagents/agent-<id>.jsonl`), record by record, and turns it into
// activity events plus the usage/metadata the trace file needs.
//
// The transcript format is undocumented and changes between Claude Code
// versions, so every field is read defensively and unknown records are skipped.
// No `vscode` import: this runs (and is tested) in plain Node.

import {
  CAPTION_MAX, EventBuilder, ParsedRecord, RecordParser, Rec, isObj, num, oneLine, str,
} from './common';

export type { ParsedRecord, SpawnInfo, TranscriptMeta, UsageSample } from './common';
export { displayPath } from './common';

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
  caption?: string;
}

// Lines actually changed in the new file, from a structuredPatch:
// '+' lines are added at the new-file cursor, '-' lines mark a deletion point.
function changedRange(patch: unknown): { start?: number; end?: number; added: number } {
  let start: number | undefined;
  let end: number | undefined;
  let added = 0;
  if (!Array.isArray(patch)) {
    return { added };
  }
  for (const hunk of patch) {
    if (!isObj(hunk) || !Array.isArray(hunk.lines)) {
      continue;
    }
    let cursor = num(hunk.newStart) ?? 1;
    for (const line of hunk.lines) {
      const l = str(line);
      if (l.startsWith('+')) {
        added++;
        start = start === undefined ? cursor : Math.min(start, cursor);
        end = end === undefined ? cursor : Math.max(end, cursor);
        cursor++;
      } else if (l.startsWith('-')) {
        start = start === undefined ? cursor : Math.min(start, cursor);
        end = end === undefined ? cursor : Math.max(end, cursor);
      } else {
        cursor++;
      }
    }
  }
  return { start, end, added };
}

export class ClaudeTranscriptParser implements RecordParser {
  private readonly pending = new Map<string, PendingTool>();
  private lastText = '';
  private contextSent = false;
  private readonly b: EventBuilder;

  constructor(
    private readonly root: string, // workspace root, for display paths
    session: string,
    agent: string, // 'main' or the subagent's type
    agentId: string,
  ) {
    this.b = new EventBuilder(root, session, agent, agentId);
  }

  feed(rec: unknown): ParsedRecord | null {
    if (!isObj(rec)) {
      return null;
    }
    const ts = str(rec.timestamp) || new Date().toISOString();
    const out: ParsedRecord = { ts, events: [], meta: [] };
    const type = str(rec.type);

    if (!this.contextSent && str(rec.cwd)) {
      this.contextSent = true;
      out.meta.push({ kind: 'context', cwd: str(rec.cwd), gitBranch: str(rec.gitBranch) });
    }

    if (type === 'ai-title' && str(rec.aiTitle)) {
      out.meta.push({ kind: 'title', title: str(rec.aiTitle) });
    } else if (type === 'pr-link' && num(rec.prNumber) !== undefined) {
      out.meta.push({ kind: 'pr', number: num(rec.prNumber) as number, url: str(rec.prUrl), repository: str(rec.prRepository) });
    } else if (type === 'cost-state') {
      out.meta.push({
        kind: 'cost',
        costUSD: num(rec.totalCostUSD) ?? 0,
        durationMs: num(rec.totalDuration) ?? 0,
        linesAdded: num(rec.totalLinesAdded) ?? 0,
        linesRemoved: num(rec.totalLinesRemoved) ?? 0,
      });
    } else if (type === 'assistant') {
      this.onAssistant(rec, out);
    } else if (type === 'user') {
      this.onUser(rec, out, ts);
    }
    return out;
  }

  private onAssistant(rec: Rec, out: ParsedRecord): void {
    const msg = rec.message;
    if (!isObj(msg)) {
      return;
    }
    const usage = msg.usage;
    const model = str(msg.model);
    if (isObj(usage) && model && !model.startsWith('<')) {
      out.usage = {
        messageId: str(msg.id) || str(rec.uuid),
        model,
        input: num(usage.input_tokens) ?? 0,
        output: num(usage.output_tokens) ?? 0,
        cacheRead: num(usage.cache_read_input_tokens) ?? 0,
        cacheCreate: num(usage.cache_creation_input_tokens) ?? 0,
      };
    }
    if (!Array.isArray(msg.content)) {
      return;
    }
    for (const block of msg.content) {
      if (!isObj(block)) {
        continue;
      }
      if (block.type === 'text' && str(block.text).trim()) {
        this.lastText = oneLine(str(block.text), CAPTION_MAX);
      } else if (block.type === 'tool_use' && str(block.id)) {
        // The agent's last words before a tool call are its "why" for it.
        this.pending.set(str(block.id), {
          name: str(block.name),
          input: isObj(block.input) ? block.input : {},
          caption: this.lastText || undefined,
        });
        this.lastText = '';
      }
    }
  }

  private onUser(rec: Rec, out: ParsedRecord, ts: string): void {
    const msg = rec.message;
    if (!isObj(msg) || !Array.isArray(msg.content)) {
      return;
    }
    const results = msg.content.filter((b): b is Rec => isObj(b) && b.type === 'tool_result');
    for (const block of results) {
      const id = str(block.tool_use_id);
      const tool = this.pending.get(id);
      if (!tool) {
        continue;
      }
      this.pending.delete(id);
      if (block.is_error === true) {
        out.meta.push({ kind: 'toolError', tool: tool.name });
      }
      // toolUseResult belongs to the record; trust it only when the record
      // carries a single result.
      const tur = results.length === 1 && isObj(rec.toolUseResult) ? rec.toolUseResult : {};
      const content = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((c) => (isObj(c) ? str(c.text) : '')).join('\n')
          : '';
      const cwd = str(rec.cwd) || this.root;
      const events = this.toolEvents(tool, tur, content, block.is_error === true, cwd, id, ts, out);
      if (events.length && tool.caption) {
        events[0].caption = tool.caption;
      }
      out.events.push(...events);
    }
  }

  private toolEvents(
    tool: PendingTool,
    tur: Rec,
    content: string,
    isError: boolean,
    cwd: string,
    id: string,
    ts: string,
    out: ParsedRecord,
  ): ActivityEvent[] {
    const input = tool.input;
    const abs = (p: string) => (p ? path.resolve(cwd, p) : '');

    switch (tool.name) {
      case 'Read': {
        if (isError) {
          return [];
        }
        const f = isObj(tur.file) ? tur.file : {};
        const file = abs(str(f.filePath) || str(input.file_path));
        if (!file || this.b.isNoise(file)) {
          return [];
        }
        const ev = this.b.base('read', 'Read', file, id, ts);
        const start = num(f.startLine) ?? num(input.offset) ?? 1;
        const count = num(f.numLines) ?? num(input.limit);
        const total = num(f.totalLines);
        if (count && count > 0) {
          ev.startLine = start;
          ev.endLine = start + count - 1;
          ev.lines = count;
          ev.detail = start === 1 && total !== undefined && count >= total
            ? `read whole file (${total} lines)`
            : `read lines ${start}-${ev.endLine}`;
        } else {
          ev.detail = 'read whole file';
        }
        return [ev];
      }

      case 'Edit':
      case 'MultiEdit':
      case 'Write':
      case 'NotebookEdit': {
        if (isError) {
          return [];
        }
        const file = abs(str(tur.filePath) || str(input.file_path) || str(input.notebook_path));
        if (!file || this.b.isNoise(file)) {
          return [];
        }
        const ev = this.b.base('write', tool.name, file, id, ts);
        const patch = changedRange(tur.structuredPatch);
        if (tool.name === 'Write' && (tur.type === 'create' || !patch.start)) {
          const n = str(input.content).split(/\r?\n/).length;
          ev.startLine = 1;
          ev.endLine = n;
          ev.lines = n;
          ev.detail = tur.type === 'create' ? `created (${n} lines)` : `rewrote (${n} lines)`;
        } else if (patch.start !== undefined) {
          ev.startLine = patch.start;
          ev.endLine = patch.end;
          ev.lines = patch.added;
          ev.detail = `edited ${patch.added} line(s) @ line ${patch.start}`;
        } else {
          ev.detail = tool.name === 'NotebookEdit' ? 'notebook edit' : 'edited';
        }
        return [ev];
      }

      case 'Grep':
      case 'Glob': {
        if (isError) {
          return [];
        }
        const rootAbs = abs(str(input.path) || '.');
        if (this.b.isNoise(rootAbs)) {
          return [];
        }
        const query = str(input.pattern);
        const listsFiles = tool.name === 'Glob' || str(input.output_mode) !== 'content';
        let hits: SearchHit[];
        if (Array.isArray(tur.filenames) && listsFiles) {
          hits = tur.filenames.map((f) => ({ file: abs(str(f)) }));
        } else {
          hits = parseHits(content, { file: rootAbs, listsFiles }, cwd);
        }
        return [this.b.search(tool.name, rootAbs, query, hits, id, ts, `${tool.name.toLowerCase()} "${query.slice(0, 48)}"`)];
      }

      case 'Bash':
        return shellEvents(
          this.b,
          [{ command: str(input.command), cwd }],
          str(tur.stdout) || content,
          isError,
          id,
          ts,
          str(input.description),
        );

      // The CodeGraph MCP tool is how agents map a codebase: a search whose
      // results the log does not itemise.
      case 'mcp__codegraph__codegraph_explore': {
        if (isError) {
          return [];
        }
        const query = str(input.query);
        const projectAbs = abs(str(input.projectPath) || '.');
        return [this.b.search('codegraph_explore', projectAbs, query, undefined, id, ts, `codegraph "${query.slice(0, 48)}"`)];
      }

      case 'Agent':
      case 'Task': {
        out.meta.push({
          kind: 'spawn',
          spawn: {
            toolUseId: id,
            agentType: str(input.subagent_type) || 'general-purpose',
            description: str(input.description),
            agentId: str(tur.agentId) || undefined,
          },
        });
        return [];
      }

      default:
        return [];
    }
  }
}
