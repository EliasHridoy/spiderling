import * as os from 'os';
import * as path from 'path';
import { ClaudeTranscriptParser } from './claudeTranscript';
import { isObj, str } from './common';
import { ScanContext, SessionSource, TailSpec, belongsToWorkspace, headRecords, listDir, readJsonFile, statOf } from './source';

// Claude Code keeps sessions at
//   <claude config>/projects/<session's folder, non-alphanumerics -> '-'>/<session>.jsonl
//   <same>/<session>/subagents/agent-<id>.jsonl (+ agent-<id>.meta.json: type, description)
//
// Sessions run from the workspace folder live in its own project folder. A
// session run from another git worktree of the same repository lives in that
// worktree's folder, so the other project folders are checked too: a log
// belongs to the workspace when the working directory it records does.

export function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

// Claude Code names a project's transcript folder after its path with every
// non-alphanumeric character replaced by '-'.
export function projectDirFor(root: string): string {
  return path.join(claudeProjectsDir(), root.replace(/[^A-Za-z0-9]/g, '-'));
}

const OTHER_DIRS_EVERY_MS = 3000; // looking through every project folder is the slow part
const LOOK_AT_RECORDS = 30;

interface Followed {
  dir: string;
  session: string;
}

export class ClaudeSource implements SessionSource {
  readonly name = 'claude';
  private readonly ownDir: string;
  private readonly followed = new Map<string, Followed>(); // main log -> where its subagents live
  private readonly rejected = new Set<string>(); // logs of other folders that are not this workspace
  private lastOthers = 0;

  constructor(private readonly root: string) {
    this.ownDir = projectDirFor(root);
  }

  scan(ctx: ScanContext): TailSpec[] {
    const found: TailSpec[] = [];
    for (const name of listDir(this.ownDir)) {
      const file = this.mainLog(this.ownDir, name);
      if (file && this.accept(ctx, file, true)) {
        found.push(this.mainSpec(file, this.ownDir));
      }
    }
    if (ctx.now - this.lastOthers >= OTHER_DIRS_EVERY_MS) {
      this.lastOthers = ctx.now;
      for (const dirName of listDir(claudeProjectsDir())) {
        const dir = path.join(claudeProjectsDir(), dirName);
        if (dir === this.ownDir || !statOf(dir)?.isDirectory()) {
          continue;
        }
        for (const name of listDir(dir)) {
          const file = this.mainLog(dir, name);
          if (file && this.accept(ctx, file, false)) {
            found.push(this.mainSpec(file, dir));
          }
        }
      }
    }
    for (const f of this.followed.values()) {
      found.push(...this.scanSubagents(ctx, f.dir, f.session));
    }
    return found;
  }

  private mainLog(dir: string, name: string): string | undefined {
    return name.endsWith('.jsonl') ? path.join(dir, name) : undefined;
  }

  private mainSpec(file: string, dir: string): TailSpec {
    const session = path.basename(file, '.jsonl');
    this.followed.set(file, { dir, session });
    return { file, session, agent: 'main', agentId: '', parser: new ClaudeTranscriptParser(this.root, session, 'main', '') };
  }

  // Is this main log new, recent enough, and (for another project folder) about this workspace?
  private accept(ctx: ScanContext, file: string, own: boolean): boolean {
    if (ctx.hasTail(file) || this.followed.has(file) || this.rejected.has(file)) {
      return false;
    }
    const st = statOf(file);
    if (!st || st.mtimeMs < ctx.cutoffMs) {
      return false;
    }
    if (own) {
      return true;
    }
    const cwd = headRecords(file, LOOK_AT_RECORDS).map((r) => (isObj(r) ? str(r.cwd) : '')).find(Boolean);
    if (!cwd) {
      return false; // nothing written yet that says where it runs: look again next time
    }
    if (!belongsToWorkspace(this.root, cwd)) {
      this.rejected.add(file);
      return false;
    }
    return true;
  }

  private scanSubagents(ctx: ScanContext, dir: string, session: string): TailSpec[] {
    const found: TailSpec[] = [];
    const subDir = path.join(dir, session, 'subagents');
    for (const name of listDir(subDir)) {
      const m = /^agent-(.+)\.jsonl$/.exec(name);
      const file = path.join(subDir, name);
      if (!m || ctx.hasTail(file)) {
        continue;
      }
      const meta = readJsonFile(path.join(subDir, `agent-${m[1]}.meta.json`));
      // The meta file lands just after the transcript; wait briefly for it so
      // the first events are labelled with the agent's type.
      if (!meta && ctx.now - (statOf(file)?.mtimeMs ?? 0) < 3000) {
        continue;
      }
      const type = (meta && typeof meta.agentType === 'string' && meta.agentType) || 'subagent';
      found.push({
        file,
        session,
        agent: type,
        agentId: m[1],
        parser: new ClaudeTranscriptParser(this.root, session, type, m[1]),
        description: meta && typeof meta.description === 'string' ? meta.description : undefined,
      });
    }
    return found;
  }
}
