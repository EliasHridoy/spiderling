import * as os from 'os';
import * as path from 'path';
import { AntigravityTranscriptParser } from './antigravityTranscript';
import { isObj, str } from './common';
import { ScanContext, SessionSource, TailSpec, belongsToWorkspace, headRecords, listDir, statOf } from './source';

// Antigravity CLI keeps one folder per conversation:
//   <agy home>/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl
// The log does not name a working directory, so a conversation belongs to the
// workspace when the first files it touches do.

export function antigravityHome(): string {
  return process.env.SPIDERLING_ANTIGRAVITY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

const PATH_ARGS = ['AbsolutePath', 'TargetFile', 'Cwd', 'SearchPath', 'SearchDirectory', 'DirectoryPath', 'Path', 'File'];
const LOOK_AT_RECORDS = 400;
const PATHS_TO_CHECK = 20;

// Absolute paths the agent's first tool calls name, skipping its own hidden
// config/skill folders and temp dirs.
function firstPaths(records: unknown[]): string[] {
  const home = os.homedir();
  const hidden = home + path.sep + '.';
  const out: string[] = [];
  for (const r of records) {
    for (const tc of isObj(r) && Array.isArray(r.tool_calls) ? r.tool_calls : []) {
      const args = isObj(tc) && isObj(tc.args) ? tc.args : {};
      for (const k of PATH_ARGS) {
        const p = str(args[k]);
        if (p.startsWith('/') && !p.startsWith('/tmp/') && !p.startsWith(hidden)) {
          out.push(p);
        }
      }
    }
    if (out.length >= PATHS_TO_CHECK) {
      break;
    }
  }
  return out.slice(0, PATHS_TO_CHECK);
}

export class AntigravitySource implements SessionSource {
  readonly name = 'antigravity';
  readonly scanEveryMs = 3000; // one folder per conversation, hundreds of them
  private readonly rejected = new Set<string>();
  private readonly undecided = new Map<string, number>(); // file -> size when last looked at

  constructor(private readonly root: string) {}

  scan(ctx: ScanContext): TailSpec[] {
    const found: TailSpec[] = [];
    const brain = path.join(antigravityHome(), 'brain');
    for (const id of listDir(brain)) {
      const file = path.join(brain, id, '.system_generated', 'logs', 'transcript_full.jsonl');
      if (ctx.hasTail(file) || this.rejected.has(file)) {
        continue;
      }
      const st = statOf(file);
      if (!st || st.mtimeMs < ctx.cutoffMs || this.undecided.get(file) === st.size) {
        continue;
      }
      const records = headRecords(file, LOOK_AT_RECORDS);
      const paths = firstPaths(records);
      if (!paths.length) {
        // Nothing to go by yet (a new conversation); once it has read a lot
        // without touching a file, it is not about code.
        if (records.length >= LOOK_AT_RECORDS) {
          this.rejected.add(file);
        } else {
          this.undecided.set(file, st.size);
        }
        continue;
      }
      if (!paths.some((p) => belongsToWorkspace(this.root, p))) {
        this.rejected.add(file);
        continue;
      }
      found.push({ file, session: id, agent: 'antigravity', agentId: '', parser: new AntigravityTranscriptParser(this.root, id) });
    }
    return found;
  }
}
