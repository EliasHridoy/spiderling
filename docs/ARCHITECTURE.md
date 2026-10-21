# Architecture

Spiderling turns the session logs that AI coding agents already write into live
views and a replayable trace. There is no agent-side component: everything is
read from files on disk.

```
 agent logs                      extension host (Node)                         webviews (browser)
 ──────────                      ─────────────────────                         ──────────────────
 ~/.claude/projects/…  ─┐
 ~/.codex/sessions/…   ─┼─► SessionSource ──► RecordParser ──► ActivityEvent ─┬─► LivePlayer ─► Code Crawl
 ~/.gemini/…/brain/…   ─┘   (find logs for    (log record →     (read / write │   (paces per agent)
                             this workspace)    events)           / search /   ├─► Crawl Map (+ recap)
                                  │                               bash)       ├─► tree view, status bar,
                                  ▼                                           │   gutter decorations
                           SessionWatcher ──► SessionTrace ──► writeTrace ─► trace JSON ─► Replay / HTML export
                           (tails the logs)   (distil + mask)   (merge)         │            (traceAnalysis.js)
                                                                                └─► "trace for this code", PR summary
```

## The capture layer (`src/transcript/`, no `vscode` import)

Everything here runs, and is tested, in plain Node.

| Module | Job |
| --- | --- |
| `source.ts` | The `SessionSource` / `TailSpec` contracts; workspace matching (`belongsToWorkspace`, `repoIdentity`, git worktrees); small fs helpers |
| `claudeSource.ts`, `codexSource.ts`, `antigravitySource.ts` | One per agent: find the log files that belong to the workspace and hand out a parser for each |
| `claudeTranscript.ts`, `codexTranscript.ts`, `antigravityTranscript.ts` | One per agent: turn one log record at a time into events, usage and metadata |
| `common.ts` | Shared types, the `EventBuilder`, scratch-path filtering, unified-diff ranges |
| `shell.ts`, `bashParse.ts` | Read a shell command (`grep`, `sed -n`, `cat`, `find`, redirects, heredocs, variables) into reads/writes/searches, and attribute its output to the searches |
| `sessionWatcher.ts` | Polls the sources for new logs, tails each (reading only appended bytes, holding a half-written last line), and feeds events onward |
| `traceStore.ts` | Builds the distilled trace per session and writes/merges trace files |
| `redact.ts` | Masks credentials in free text before it goes into a trace |
| `symbols.ts` | Names the function around a line from the repo's CodeGraph index (optional) |

Decisions worth knowing:

- **Polling, not file watching.** A few `stat`/`read` calls every 700 ms is cheap, behaves
  the same on every platform and copes with logs appearing in new folders.
- **Parse defensively.** The agents' log formats are undocumented and change. Every field
  is checked; unknown records are skipped; a parser never throws on bad input.
- **Source, parser, watcher are separate.** The watcher knows nothing about any agent.
  Adding an agent means a source and a parser (see [AGENT_SUPPORT.md](AGENT_SUPPORT.md)).
- **Workspace matching is by path, not by name.** Claude records its working directory in
  every record, Codex in `session_meta`, Antigravity only in the files its tools touch; a
  log belongs to the workspace when that path is inside it or in another worktree of the
  same repository.
- **History is quiet, now is live.** Events older than the extension's start are replayed
  into the recap and the trace but not animated; only what happens after is "live".

## The live view (`src/livePlayer.ts`, `media/codecrawl.js`)

An agent can read twenty files in one burst, and a view cannot show twenty files at
once. `LivePlayer` keeps one queue per agent and plays its steps one at a time: the more
steps are waiting, the faster each plays, and a lane that falls more than 24 steps behind
drops the oldest, so the view stays with where the agent *is*. The recap and the trace keep
every step. When an agent reads a file that its previous search returned, the step is
tagged with the hit it came from and the spider walks from that hit into the file.

## The trace and the replay

`SessionTrace` collects a session into the [trace format](TRACE_FORMAT.md) while masking
free text. `writeTrace` merges it into the session's file (rewritten atomically, every few
seconds while the agent runs). Symbols found while a step was live are carried across
rebuilds, because the index describes today's code and cannot name yesterday's steps.

`media/traceAnalysis.js` holds everything that interprets a trace and is a plain script
with no DOM and no VS Code API, so the replay page, the exported HTML, the PR summary and
the tests share it:

- **phases**: each step is classified by its agent's role and by what it did; a weighted
  vote over neighbouring steps smooths parallel agents; short runs are folded away, and a
  brief look-around between two stretches of the same work is part of that work;
- **edges**: a search → the file it led to; the files read and searches run since an
  agent's previous edit → that edit;
- **drift signals**: files re-read or rewritten many times (notes and plans excluded),
  empty-search runs, repeated queries, failed tool calls, idle time;
- **flow**: the queries → files read → files edited graph as of a step.

`media/replay.js` renders it. The same page is the extension's replay panel and, with the
trace inlined, the standalone HTML export.

## The extension shell (`src/`)

`extension.ts` wires the watcher to the views and registers the commands.
`codeCrawl.ts`, `crawlMap.ts` and `replay.ts` own the webview panels; `traceQuery.ts` answers
"which steps touched these lines?" for the editor command; `activityState.ts`, `treeView.ts`
and `decorations.ts` feed the Explorer view, the status bar and the gutter spider.

## Testing

`npm test` runs `test/*.test.js` with Node's built-in runner: the Bash parser, each agent's
parser (on synthetic records in the observed shapes), source discovery (including git
worktrees), the watcher end to end, the trace store, masking, the live player, the symbol
index (against a miniature CodeGraph database), the analysis and the editor query.
Real logs contain private code, so the fixtures are synthetic.
