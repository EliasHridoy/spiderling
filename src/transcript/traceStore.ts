import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActivityEvent } from '../types';
import { TranscriptMeta, UsageSample } from './claudeTranscript';
import { Redactor } from './redact';

// Collects one Claude Code session into the distilled, shareable trace that is
// written next to the issue's instructions.md / plan.md as
// `docs/<issue>/agent-trace.json`.
//
// Distilled on purpose: paths, line ranges, search queries/hit counts, the
// agent's one-line captions and metrics. Never file contents or tool output.
// Free text is passed through the redactor first (credentials -> [redacted]).

export const TRACE_FILE = 'agent-trace.json';
const SCHEMA = 'spiderling.agent-trace/v1';
// Older builds wrote this id; their files are still read and merged.
const LEGACY_SCHEMAS = ['amlog.agent-trace/v1'];

// `<repo>/docs/<issue>/<file>`: an optional per-issue docs folder (instructions.md,
// plan.md...) next to which a session's trace can be written.
const DOCS_FILE = /^(.*)[/\\]docs[/\\](\d+)[/\\]([^/\\]+)$/;
const KEY_DOCS = new Set(['instructions.md', 'plan.md', 'research.md']);

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  messages: number;
}

interface AgentInfo {
  key: string;
  type: string;
  id: string;
  description: string;
  firstTs: string;
  lastTs: string;
  steps: number;
  errors: number; // failed tool calls
}

interface Step {
  t: string;
  agent: string;
  op: string;
  file: string;
  lines?: [number, number];
  detail?: string;
  query?: string;
  hits?: number;
  hitFiles?: string[]; // distinct files a search found (paths only)
  symbol?: string; // function/class around the lines, from the CodeGraph index (live steps)
  caption?: string;
}

// A step waits this long before its symbol is looked up, so the CodeGraph index
// has caught up with the edit.
const SYMBOL_DELAY_MS = 1500;
const MAX_HIT_FILES = 25;

// Paths outside the workspace are absolute; keep the home directory (and so the
// user name) out of a file that gets shared in a PR.
export function shareablePath(p: string): string {
  const home = os.homedir();
  return home && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\')) ? `~${p.slice(home.length)}` : p;
}

export function agentKey(agent: string, agentId: string): string {
  return agentId ? `${agent}:${agentId}` : agent;
}

export class SessionTrace {
  title = '';
  source = ''; // which agent wrote the session: claude | codex | antigravity
  cwd = '';
  gitBranch = '';
  pr?: { number: number; url: string; repository: string };
  cost?: { costUSD: number; durationMs: number; linesAdded: number; linesRemoved: number };
  firstTs = '';
  lastTs = '';
  dirty = false;
  private readonly agents = new Map<string, AgentInfo>();
  private readonly usage = new Map<string, { agent: string; sample: UsageSample }>();
  private readonly steps: Step[] = [];
  private readonly docsVotes = new Map<string, number>();
  private readonly redactor = new Redactor();
  private pendingSymbols: { step: Step; abs: string; line: number; at: number }[] = [];

  constructor(readonly sessionId: string) {}

  private touch(ts: string): void {
    if (!this.firstTs || ts < this.firstTs) {
      this.firstTs = ts;
    }
    if (!this.lastTs || ts > this.lastTs) {
      this.lastTs = ts;
    }
    this.dirty = true;
  }

  private agentFor(key: string, type: string, id: string, ts: string): AgentInfo {
    let a = this.agents.get(key);
    if (!a) {
      a = { key, type, id, description: '', firstTs: ts, lastTs: ts, steps: 0, errors: 0 };
      this.agents.set(key, a);
    }
    if (ts < a.firstTs) {
      a.firstTs = ts;
    }
    if (ts > a.lastTs) {
      a.lastTs = ts;
    }
    return a;
  }

  describeAgent(type: string, id: string, description: string): void {
    const a = this.agentFor(agentKey(type, id), type, id, this.lastTs || new Date().toISOString());
    const clean = this.redactor.text(description);
    if (clean && a.description !== clean) {
      a.description = clean;
      this.dirty = true;
    }
  }

  addEvent(ev: ActivityEvent, live = false): void {
    this.touch(ev.ts);
    const key = agentKey(ev.agent, ev.agentId);
    const agent = this.agentFor(key, ev.agent, ev.agentId, ev.ts);
    agent.steps++;
    const step: Step = { t: ev.ts, agent: key, op: ev.op, file: this.redactor.text(shareablePath(ev.file)) };
    if (ev.startLine !== undefined) {
      step.lines = [ev.startLine, ev.endLine ?? ev.startLine];
    }
    if (ev.detail) {
      step.detail = this.redactor.text(ev.detail);
    }
    if (ev.query !== undefined) {
      step.query = this.redactor.text(ev.query);
      if (ev.hitCount !== undefined) {
        step.hits = ev.hitCount; // absent when the agent's log doesn't say what it found
      }
      const files = [...new Set((ev.hits ?? []).map((h) => this.redactor.text(shareablePath(h.file))))].slice(0, MAX_HIT_FILES);
      if (files.length) {
        step.hitFiles = files;
      }
    }
    if (ev.caption) {
      step.caption = this.redactor.text(ev.caption);
    }
    this.steps.push(step);
    if (live && ev.absFile && ev.startLine !== undefined && (ev.op === 'read' || ev.op === 'write')) {
      this.pendingSymbols.push({ step, abs: ev.absFile, line: ev.startLine, at: Date.now() });
    }

    const m = ev.absFile ? DOCS_FILE.exec(ev.absFile) : null;
    if (m) {
      const dir = path.join(m[1], 'docs', m[2]);
      this.docsVotes.set(dir, (this.docsVotes.get(dir) ?? 0) + (KEY_DOCS.has(m[3]) ? 5 : 1));
    }
  }

  addUsage(agent: string, agentId: string, sample: UsageSample, ts: string): void {
    this.touch(ts);
    this.agentFor(agentKey(agent, agentId), agent, agentId, ts);
    // One API response is split over several records that repeat its usage;
    // keep the last copy per message.
    this.usage.set(sample.messageId, { agent: agentKey(agent, agentId), sample });
  }

  addMeta(meta: TranscriptMeta, agent = 'main', agentId = ''): void {
    if (meta.kind === 'toolError') {
      this.agentFor(agentKey(agent, agentId), agent, agentId, this.lastTs || new Date().toISOString()).errors++;
    } else if (meta.kind === 'title') {
      this.title = this.redactor.text(meta.title);
    } else if (meta.kind === 'pr') {
      this.pr = { number: meta.number, url: meta.url, repository: meta.repository };
    } else if (meta.kind === 'cost') {
      this.cost = { costUSD: meta.costUSD, durationMs: meta.durationMs, linesAdded: meta.linesAdded, linesRemoved: meta.linesRemoved };
    } else if (meta.kind === 'context') {
      this.cwd = this.cwd || meta.cwd;
      this.gitBranch = this.gitBranch || meta.gitBranch;
    } else if (meta.kind === 'spawn' && meta.spawn.agentId) {
      this.describeAgent(meta.spawn.agentType, meta.spawn.agentId, meta.spawn.description);
    }
    this.dirty = true;
  }

  // Look up the symbol around each recent live step. `force` resolves everything
  // pending (used on shutdown); otherwise a step waits for the index to catch up.
  resolveSymbols(lookup: (abs: string, line: number) => string | undefined, force = false, now = Date.now()): void {
    const keep: SessionTrace['pendingSymbols'] = [];
    for (const p of this.pendingSymbols) {
      if (!force && now - p.at < SYMBOL_DELAY_MS) {
        keep.push(p);
        continue;
      }
      const symbol = lookup(p.abs, p.line);
      if (symbol) {
        p.step.symbol = this.redactor.text(symbol);
        this.dirty = true;
      }
    }
    this.pendingSymbols = keep;
  }

  get hasPendingSymbols(): boolean {
    return this.pendingSymbols.length > 0;
  }

  // The issue's docs folder this session worked in: the `docs/<n>/` it touched
  // most, weighting instructions/plan/research files.
  docsDir(): string | undefined {
    let best: string | undefined;
    let bestVotes = 0;
    for (const [dir, votes] of this.docsVotes) {
      if (votes > bestVotes) {
        best = dir;
        bestVotes = votes;
      }
    }
    return best;
  }

  toJSON(): Record<string, unknown> {
    const tokensByAgent = new Map<string, Record<string, TokenTotals>>();
    const tokensByModel: Record<string, TokenTotals> = {};
    const add = (into: Record<string, TokenTotals>, s: UsageSample) => {
      const t = into[s.model] ?? (into[s.model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 });
      t.input += s.input;
      t.output += s.output;
      t.cacheRead += s.cacheRead;
      t.cacheCreate += s.cacheCreate;
      t.messages++;
    };
    for (const { agent, sample } of this.usage.values()) {
      if (!tokensByAgent.has(agent)) {
        tokensByAgent.set(agent, {});
      }
      add(tokensByAgent.get(agent) as Record<string, TokenTotals>, sample);
      add(tokensByModel, sample);
    }
    const ms = (a: string, b: string) => Math.max(0, Date.parse(b) - Date.parse(a)) || 0;
    return {
      title: this.title,
      source: this.source || undefined,
      branch: this.gitBranch,
      redactions: this.redactor.count,
      startedAt: this.firstTs,
      endedAt: this.lastTs,
      pr: this.pr,
      metrics: {
        costUSD: this.cost?.costUSD,
        durationMs: this.cost?.durationMs ?? ms(this.firstTs, this.lastTs),
        linesAdded: this.cost?.linesAdded,
        linesRemoved: this.cost?.linesRemoved,
        tokens: tokensByModel,
      },
      agents: [...this.agents.values()]
        .sort((a, b) => a.firstTs.localeCompare(b.firstTs))
        .map((a) => ({
          key: a.key,
          type: a.type,
          description: a.description || undefined,
          startedAt: a.firstTs,
          endedAt: a.lastTs,
          durationMs: ms(a.firstTs, a.lastTs),
          steps: a.steps,
          errors: a.errors || undefined,
          tokens: tokensByAgent.get(a.key) ?? {},
        })),
      steps: [...this.steps].sort((a, b) => a.t.localeCompare(b.t)),
    };
  }
}

// Writes (merges) a session into its trace file. Returns the path written, or
// undefined when there was nowhere to write or nothing changed.
//
// Target: `<traceDir>/<session>.json`, one file per session. With `issueDocs`,
// a session that touched an issue's `docs/<n>/` folder is written to
// `docs/<n>/agent-trace.json` instead: one file per issue, holding every
// session that worked on it.
export function writeTrace(
  trace: SessionTrace,
  traceDir: string | undefined,
  lastWritten: Map<string, string>,
  issueDocs = false,
): string | undefined {
  const docs = issueDocs ? trace.docsDir() : undefined;
  let file: string;
  let doc: Record<string, unknown>;
  const session = trace.toJSON();

  if (docs && isDir(docs)) {
    file = path.join(docs, TRACE_FILE);
    const existing = readJson(file);
    const known = existing && (existing.schema === SCHEMA || LEGACY_SCHEMAS.includes(String(existing.schema)));
    const sessions = known && existing && isRecord(existing.sessions) ? existing.sessions : {};
    carrySymbols(sessions[trace.sessionId], session);
    sessions[trace.sessionId] = session;
    doc = { schema: SCHEMA, issue: path.basename(docs), sessions: sortByStart(sessions) };
  } else if (traceDir) {
    file = path.join(traceDir, `${trace.sessionId}.json`);
    doc = { schema: SCHEMA, issue: null, sessions: { [trace.sessionId]: session } };
  } else {
    return undefined;
  }

  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (lastWritten.get(file) === text) {
    return undefined;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!docs) {
    keepOutOfGit(path.dirname(file));
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  lastWritten.set(file, text);
  return file;
}

// Symbols are looked up while a step is live; when the session is later rebuilt
// from its log (a restart), keep the ones already in the file.
export function carrySymbols(previous: unknown, session: Record<string, unknown>): void {
  if (!isRecord(previous) || !Array.isArray(previous.steps) || !Array.isArray(session.steps)) {
    return;
  }
  const key = (s: Record<string, unknown>) => `${s.t}|${s.agent}|${s.file}|${Array.isArray(s.lines) ? s.lines.join('-') : ''}`;
  const known = new Map<string, string>();
  for (const s of previous.steps) {
    if (isRecord(s) && typeof s.symbol === 'string') {
      known.set(key(s), s.symbol);
    }
  }
  for (const s of session.steps) {
    if (isRecord(s) && s.symbol === undefined && known.has(key(s))) {
      s.symbol = known.get(key(s));
    }
  }
}

// A trace folder of our own ignores itself, the way `.venv` does: a `.gitignore`
// holding `*` hides the folder, and that file with it, from `git status`.
function keepOutOfGit(dir: string): void {
  const ignore = path.join(dir, '.gitignore');
  try {
    if (!fs.existsSync(ignore)) {
      fs.writeFileSync(ignore, '*\n', 'utf8');
    }
  } catch {
    // read-only folder: the trace write itself will report the problem
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function sortByStart(sessions: Record<string, unknown>): Record<string, unknown> {
  const start = (s: unknown) => (isRecord(s) && typeof s.startedAt === 'string' ? s.startedAt : '');
  return Object.fromEntries(Object.entries(sessions).sort(([, a], [, b]) => start(a).localeCompare(start(b))));
}
