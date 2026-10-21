import * as fs from 'fs';
import { ActivityEvent } from '../types';
import { RecordParser } from './common';
import { AntigravitySource } from './antigravitySource';
import { ClaudeSource } from './claudeSource';
import { CodexSource } from './codexSource';
import { SessionSource, TailSpec } from './source';
import { SymbolIndex } from './symbols';
import { SessionTrace, writeTrace } from './traceStore';

// Follows the session logs of every enabled agent (Claude Code, Codex,
// Antigravity) for the workspace. Each source discovers its own log files; this
// class tails them, turns their records into events through the matching parser,
// feeds the trace store, and writes trace files.
//
// Polling, not fs.watch: a handful of stat/read calls per tick is cheap, works
// the same on every platform, and survives files appearing in new directories.

export const ALL_SOURCES = ['claude', 'codex', 'antigravity'] as const;

export interface WatcherOptions {
  root: string; // workspace folder
  lookbackMs: number; // replay sessions active within this window at startup
  pollMs: number;
  sources?: string[]; // which agents to follow (default: all)
  symbols?: boolean; // name the function around live steps from the CodeGraph index (default: true)
  traceFallbackDir?: string; // where traces go (one file per session)
  issueDocs?: boolean; // write a session that touched docs/<n>/ next to it, as docs/<n>/agent-trace.json
  writeTraces: boolean;
  onEvent: (event: ActivityEvent, live: boolean) => void;
  onTraceWritten?: (file: string) => void;
  onError?: (message: string) => void;
}

interface Tail extends TailSpec {
  source: string;
  parser: RecordParser;
  offset: number;
  partial: string;
  drainedOnce: boolean;
}

// Skip replaying a backlog bigger than this; follow the file from its end.
const MAX_BACKLOG_BYTES = 64 * 1024 * 1024;
const TRACE_FLUSH_MS = 3000;

export class SessionWatcher {
  readonly traces = new Map<string, SessionTrace>();
  private readonly sources: SessionSource[];
  private readonly lastScan = new Map<string, number>();
  private readonly tails = new Map<string, Tail>();
  private readonly sessions = new Set<string>(); // sessions whose main log is tailed
  private readonly startedAt = Date.now();
  private readonly lastWritten = new Map<string, string>();
  private readonly symbolIndex?: SymbolIndex;
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly flushTimer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: WatcherOptions) {
    const want = new Set(opts.sources ?? ALL_SOURCES);
    this.sources = [];
    if (want.has('claude')) {
      this.sources.push(new ClaudeSource(opts.root));
    }
    if (want.has('codex')) {
      this.sources.push(new CodexSource(opts.root));
    }
    if (want.has('antigravity')) {
      this.sources.push(new AntigravitySource(opts.root));
    }
    if (opts.symbols !== false) {
      this.symbolIndex = new SymbolIndex();
    }
    this.scan();
    this.pollTimer = setInterval(() => this.scan(), opts.pollMs);
    this.flushTimer = setInterval(() => this.flush(), TRACE_FLUSH_MS);
  }

  isTracked(session: string): boolean {
    return this.sessions.has(session);
  }

  private scan(): void {
    const now = Date.now();
    const ctx = {
      root: this.opts.root,
      cutoffMs: this.startedAt - this.opts.lookbackMs,
      now,
      hasTail: (file: string) => this.tails.has(file),
    };
    for (const source of this.sources) {
      if (source.scanEveryMs && now - (this.lastScan.get(source.name) ?? 0) < source.scanEveryMs) {
        continue;
      }
      this.lastScan.set(source.name, now);
      let specs: TailSpec[] = [];
      try {
        specs = source.scan(ctx);
      } catch (err) {
        this.opts.onError?.(`Spiderling: could not scan ${source.name} sessions (${String(err)})`);
      }
      for (const spec of specs) {
        this.track(source.name, spec);
      }
    }
    for (const tail of this.tails.values()) {
      this.drain(tail);
    }
  }

  private track(source: string, spec: TailSpec): void {
    if (this.tails.has(spec.file)) {
      return;
    }
    const size = fs.statSync(spec.file, { throwIfNoEntry: false })?.size ?? 0;
    this.tails.set(spec.file, {
      ...spec,
      source,
      offset: size > MAX_BACKLOG_BYTES ? size : 0,
      partial: '',
      drainedOnce: false,
    });
    const trace = this.trace(spec.session, source);
    if (!spec.agentId) {
      this.sessions.add(spec.session);
    } else if (spec.description) {
      trace.describeAgent(spec.agent, spec.agentId, spec.description);
    }
  }

  private trace(session: string, source: string): SessionTrace {
    let t = this.traces.get(session);
    if (!t) {
      t = new SessionTrace(session);
      t.source = source;
      this.traces.set(session, t);
    }
    return t;
  }

  private drain(tail: Tail): void {
    const st = fs.statSync(tail.file, { throwIfNoEntry: false });
    if (!st) {
      return;
    }
    if (st.size < tail.offset) {
      tail.offset = 0; // rewritten / truncated
      tail.partial = '';
    }
    if (st.size === tail.offset) {
      tail.drainedOnce = true;
      return;
    }
    let chunk: string;
    try {
      const fd = fs.openSync(tail.file, 'r');
      try {
        const length = st.size - tail.offset;
        const buf = Buffer.alloc(length);
        const read = fs.readSync(fd, buf, 0, length, tail.offset);
        chunk = buf.toString('utf8', 0, read);
        tail.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }

    const lines = (tail.partial + chunk).split('\n');
    tail.partial = lines.pop() ?? ''; // an in-flight append; finish it next time
    const trace = this.trace(tail.session, tail.source);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = tail.parser.feed(rec);
      } catch (err) {
        this.opts.onError?.(`Spiderling: could not read a ${tail.source} record (${String(err)})`);
        continue;
      }
      if (!parsed) {
        continue;
      }
      for (const meta of parsed.meta) {
        trace.addMeta(meta, tail.agent, tail.agentId);
      }
      if (parsed.usage) {
        trace.addUsage(tail.agent, tail.agentId, parsed.usage, parsed.ts);
      }
      for (const ev of parsed.events) {
        // Backlog replays quietly; anything that happened after the extension
        // started (or arrives in a later read) is live.
        const live = tail.drainedOnce || Date.parse(ev.ts) >= this.startedAt;
        trace.addEvent(ev, live && !!this.symbolIndex);
        this.opts.onEvent(ev, live);
      }
    }
    tail.drainedOnce = true;
  }

  private flush(force = false): void {
    if (!this.opts.writeTraces) {
      return;
    }
    const index = this.symbolIndex;
    for (const trace of this.traces.values()) {
      if (index && trace.hasPendingSymbols) {
        trace.resolveSymbols((abs, line) => index.lookup(abs, line), force);
      }
      if (!trace.dirty) {
        continue;
      }
      trace.dirty = false;
      try {
        const file = writeTrace(trace, this.opts.traceFallbackDir, this.lastWritten, this.opts.issueDocs === true);
        if (file) {
          this.opts.onTraceWritten?.(file);
        }
      } catch (err) {
        this.opts.onError?.(`Spiderling: could not write the agent trace (${String(err)})`);
      }
    }
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    clearInterval(this.flushTimer);
    this.flush(true);
    this.symbolIndex?.dispose();
  }
}
