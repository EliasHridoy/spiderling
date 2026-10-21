import * as fs from 'fs';
import * as path from 'path';
import { RecordParser } from './common';

// A "source" knows where one agent keeps its session logs and which of them
// belong to the open workspace. The watcher asks every source for new logs to
// follow and tails them; everything past that point is agent-neutral.

export interface TailSpec {
  file: string;
  session: string;
  agent: string; // 'main' | a subagent's type | 'codex' | 'antigravity'
  agentId: string; // '' for a session's main log
  parser: RecordParser;
  description?: string; // what a subagent was asked to do
}

export interface ScanContext {
  root: string; // workspace folder
  cutoffMs: number; // ignore logs not modified since then (history before the lookback window)
  now: number;
  hasTail(file: string): boolean;
}

export interface SessionSource {
  readonly name: string; // 'claude' | 'codex' | 'antigravity'
  // Don't scan more often than this (sources that list many folders).
  readonly scanEveryMs?: number;
  // New log files to follow, found since the last scan.
  scan(ctx: ScanContext): TailSpec[];
}

// ---- which workspace does a path belong to? ----------------------------------------

// The repository a directory belongs to, resolving git worktrees to their main
// repository: agents often work in a sibling worktree (`repo-wt/KAN-12`) of the
// folder VS Code has open.
const identityCache = new Map<string, string | undefined>();

export function repoIdentity(start: string): string | undefined {
  let dir = path.resolve(start);
  const visited: string[] = [];
  let found: string | undefined;
  for (let i = 0; i < 40; i++) {
    if (identityCache.has(dir)) {
      found = identityCache.get(dir);
      break;
    }
    visited.push(dir);
    const git = path.join(dir, '.git');
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(git);
    } catch {
      st = undefined;
    }
    if (st) {
      if (st.isDirectory()) {
        found = dir;
      } else {
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'));
          const gitdir = m ? path.resolve(dir, m[1].trim()) : '';
          const wt = gitdir.split(path.sep).join('/').indexOf('/.git/worktrees/');
          found = wt >= 0 ? gitdir.split(path.sep).join('/').slice(0, wt) : dir;
        } catch {
          found = dir;
        }
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  for (const v of visited) {
    identityCache.set(v, found);
  }
  return found;
}

const within = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Is `p` (a file or directory, absolute) part of this workspace: under its
// folder, or in another worktree of the same repository.
export function belongsToWorkspace(root: string, p: string): boolean {
  if (!p || !path.isAbsolute(p)) {
    return false;
  }
  if (within(root, p)) {
    return true;
  }
  const mine = repoIdentity(root);
  return !!mine && repoIdentity(p) === mine;
}

// ---- small fs helpers shared by the sources -----------------------------------------

export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function statOf(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

export function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

// The first `maxLines` JSON records of a log (a cheap look at how a session
// started, without reading a possibly huge file).
export function headRecords(file: string, maxLines: number, maxBytes = 512 * 1024): unknown[] {
  const out: unknown[] = [];
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n').slice(0, maxLines)) {
      if (!line.trim()) {
        continue;
      }
      try {
        out.push(JSON.parse(line));
      } catch {
        // a record cut off at the end of the window, or a stray line
      }
    }
  } catch {
    // unreadable: no records
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  return out;
}
