import * as os from 'os';
import * as path from 'path';
import { CodexTranscriptParser } from './codexTranscript';
import { isObj, str } from './common';
import { ScanContext, SessionSource, TailSpec, belongsToWorkspace, headRecords, listDir, statOf } from './source';

// Codex CLI keeps one rollout per session at
//   <codex home>/sessions/YYYY/MM/DD/rollout-<local time>-<session id>.jsonl
// (local date). The first record, `session_meta`, names the working directory,
// which says which workspace the session belongs to.

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayDir = (d: Date) => path.join(codexHome(), 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));

// The day folders that can hold a session active inside the window: today and
// yesterday always (a long session lives in the folder of the day it started),
// and every day back to the cutoff.
function dayDirs(cutoffMs: number, now: number): string[] {
  const dirs = new Set<string>();
  const day = 24 * 3600e3;
  const from = Math.max(cutoffMs - day, now - 14 * day);
  for (let t = now; t >= from; t -= day) {
    dirs.add(dayDir(new Date(t)));
  }
  dirs.add(dayDir(new Date(now - day)));
  return [...dirs];
}

export class CodexSource implements SessionSource {
  readonly name = 'codex';
  private readonly rejected = new Set<string>();

  constructor(private readonly root: string) {}

  scan(ctx: ScanContext): TailSpec[] {
    const found: TailSpec[] = [];
    for (const dir of dayDirs(ctx.cutoffMs, ctx.now)) {
      for (const name of listDir(dir)) {
        if (!/^rollout-.*\.jsonl$/.test(name)) {
          continue;
        }
        const file = path.join(dir, name);
        if (ctx.hasTail(file) || this.rejected.has(file)) {
          continue;
        }
        const st = statOf(file);
        if (!st || st.mtimeMs < ctx.cutoffMs) {
          continue;
        }
        const meta = headRecords(file, 5).find((r) => isObj(r) && r.type === 'session_meta');
        const payload = isObj(meta) && isObj(meta.payload) ? meta.payload : undefined;
        const cwd = payload ? str(payload.cwd) : '';
        if (!cwd) {
          continue; // not written yet: look again next time
        }
        if (!belongsToWorkspace(this.root, cwd)) {
          this.rejected.add(file);
          continue;
        }
        const session = (payload && str(payload.id)) || (/([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1] ?? name);
        found.push({ file, session, agent: 'codex', agentId: '', parser: new CodexTranscriptParser(this.root, session) });
      }
    }
    return found;
  }
}
