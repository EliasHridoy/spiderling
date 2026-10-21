import * as os from 'os';
import * as path from 'path';
import { ActivityEvent, SearchHit } from '../types';

// Pieces shared by every agent's transcript parser (Claude Code, Codex,
// Antigravity). A parser turns one agent's session log, record by record, into
// the same ActivityEvents plus the usage/metadata the trace file needs.
// No `vscode` import: all of this runs (and is tested) in plain Node.

export interface UsageSample {
  messageId: string;
  model: string;
  input: number; // uncached input tokens
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface SpawnInfo {
  toolUseId: string;
  agentType: string;
  description: string;
  agentId?: string;
}

export type TranscriptMeta =
  | { kind: 'title'; title: string }
  | { kind: 'pr'; number: number; url: string; repository: string }
  | { kind: 'cost'; costUSD: number; durationMs: number; linesAdded: number; linesRemoved: number }
  | { kind: 'spawn'; spawn: SpawnInfo }
  | { kind: 'context'; cwd: string; gitBranch: string }
  | { kind: 'toolError'; tool: string }; // a tool call that failed (counts toward the drift signals)

export interface ParsedRecord {
  ts: string;
  events: ActivityEvent[];
  usage?: UsageSample;
  meta: TranscriptMeta[];
}

// What a source hands the watcher for every log file it follows.
export interface RecordParser {
  feed(rec: unknown): ParsedRecord | null;
}

export type Rec = Record<string, unknown>;
export const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const MAX_HITS = 50;
export const CAPTION_MAX = 220;

export function displayPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  if (rel === '') {
    return '.';
  }
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return abs.split(path.sep).join('/');
}

// One tidy line from an agent's prose: markdown marks dropped, whitespace
// collapsed, cut to `max` characters.
export function oneLine(text: string, max: number): string {
  const t = text.replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// The agent's own scratch space (temp dirs, the agent CLIs' config/memory
// folders) is not code it is working on; it stays out of the views and the trace.
const SCRATCH_ROOTS = [
  os.tmpdir(),
  '/tmp',
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), '.codex'),
  path.join(os.homedir(), '.gemini'),
].map((p) => path.resolve(p) + path.sep);

// Builds ActivityEvents for one agent in one session.
export class EventBuilder {
  constructor(
    readonly root: string, // workspace root, for display paths
    readonly session: string,
    readonly agent: string, // 'main', a subagent's type, 'codex', 'antigravity'
    readonly agentId: string,
  ) {}

  isNoise(abs: string): boolean {
    if (!abs) {
      return false;
    }
    const a = abs + path.sep; // so a scratch directory itself counts, not only what is inside it
    if (a.startsWith(this.root + path.sep)) {
      return false;
    }
    return SCRATCH_ROOTS.some((r) => a.startsWith(r));
  }

  abs(cwd: string, p: string): string {
    return p ? path.resolve(cwd, p) : '';
  }

  base(op: ActivityEvent['op'], tool: string, abs: string, toolUseId: string, ts: string): ActivityEvent {
    return {
      ts,
      op,
      file: abs ? displayPath(this.root, abs) : '(bash)',
      absFile: abs || undefined,
      agent: this.agent,
      agentId: this.agentId,
      tool,
      session: this.session,
      toolUseId,
    };
  }

  // `hitsAbs` undefined means the agent's log does not say what the search found
  // (as opposed to an empty list: it found nothing).
  search(
    tool: string,
    rootAbs: string,
    query: string,
    hitsAbs: SearchHit[] | undefined,
    toolUseId: string,
    ts: string,
    label: string,
  ): ActivityEvent {
    const ev = this.base('search', tool, rootAbs, toolUseId, ts);
    ev.query = query;
    if (!hitsAbs) {
      ev.detail = label;
      return ev;
    }
    const files = new Set(hitsAbs.map((h) => h.file));
    ev.hitCount = hitsAbs.length;
    ev.hits = hitsAbs.slice(0, MAX_HITS).map((h) => ({
      ...h,
      file: displayPath(this.root, h.file),
      text: h.text ? h.text.slice(0, 200) : undefined,
    }));
    ev.detail = hitsAbs.length
      ? `${label} → ${hitsAbs.length} hit(s) in ${files.size} file(s)`
      : `${label} → no hits`;
    return ev;
  }
}

// New-side line range of a unified diff (`@@ -a,b +c,d @@` hunks): from the
// first to the last changed line, and how many lines were added.
export function unifiedDiffRange(diff: string): { start?: number; end?: number; added: number } {
  let start: number | undefined;
  let end: number | undefined;
  let added = 0;
  let cursor = 0;
  for (const line of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      cursor = Number(h[1]);
      continue;
    }
    if (!cursor || line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      added++;
      start = start === undefined ? cursor : Math.min(start, cursor);
      end = end === undefined ? cursor : Math.max(end, cursor);
      cursor++;
    } else if (line.startsWith('-')) {
      start = start === undefined ? cursor : Math.min(start, cursor);
      end = end === undefined ? cursor : Math.max(end, cursor);
    } else if (!line.startsWith('\\')) {
      cursor++;
    }
  }
  return { start, end, added };
}
