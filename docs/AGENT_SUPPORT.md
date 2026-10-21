# Agent support

What Spiderling reads from each agent, how it decides a session belongs to your
workspace, what the logs do not contain, and how to add another agent.

Log formats are **undocumented and change between versions**. The notes below describe
what was observed in the versions listed; Spiderling skips records it does not
understand rather than failing.

## Claude Code

|  |  |
| --- | --- |
| Log | `<config>/projects/<folder>/<session>.jsonl`, and `<session>/subagents/agent-<id>.jsonl` with `agent-<id>.meta.json` (type, description). `<config>` is `~/.claude` or `$CLAUDE_CONFIG_DIR`; `<folder>` is the session's directory with every non-alphanumeric character replaced by `-` |
| Observed with | 2.1.30x |
| Belongs to the workspace when | the log is in the workspace's own project folder, or (another folder) its records' `cwd` is in the workspace or another worktree of its repository |
| Read | `Read`/`Edit`/`Write`/`NotebookEdit` results (exact lines from `startLine`/`numLines` and `structuredPatch`), `Bash` commands and their output, `Grep`/`Glob`, `mcp__codegraph__codegraph_explore`, `Agent` (subagents), assistant text (captions), `usage`, `cost-state`, `pr-link`, `ai-title` |
| Not available | Thinking (stored redacted) |

## Codex CLI

|  |  |
| --- | --- |
| Log | `<codex home>/sessions/YYYY/MM/DD/rollout-<local time>-<session id>.jsonl` (`~/.codex` or `$CODEX_HOME`); the date folders are local dates |
| Observed with | 0.142 – 0.163 |
| Belongs to the workspace when | the first record, `session_meta`, has a `cwd` in the workspace or another worktree of its repository |
| Read | `exec_command` calls and the `exec` tool (a JS snippet calling `tools.exec_command({cmd})`), parsed like shell commands with their output; `apply_patch` plus the `patch_apply_end` event, whose unified diff gives exact lines; `agent_message` and assistant messages (captions); `token_usage_record`; `turn_context` (model); the `codegraph_explore` MCP call |
| Not available | Reasoning content; edits whose diff is missing from the log show no line range |

## Antigravity CLI

|  |  |
| --- | --- |
| Log | `<agy home>/brain/<conversation>/.system_generated/logs/transcript_full.jsonl` (`~/.gemini/antigravity-cli`, overridable with `SPIDERLING_ANTIGRAVITY_HOME`) |
| Observed with | 1.4.x |
| Belongs to the workspace when | the first files its tool calls name (skipping temp files and its own hidden folders) are in the workspace or another worktree of its repository; the log has no working directory of its own |
| Read | `PLANNER_RESPONSE` turns and their `tool_calls`: `view_file`/`read_file` (line ranges), `replace_file_content`, `multi_replace_file_content`, `write_to_file`, `edit_file`, `run_command`/`run_bash` (parsed like shell), `find_by_name`, `grep_search`, `list_dir`, the `codegraph_explore` MCP call, `invoke_subagent`; token counts; each call's own one-line summary as its caption |
| Limits | Tool results are plain-text `GENERIC` steps with no call id, and parallel calls finish in any order, so an exit code or a hit list is attached only when a turn made a single call. `grep_search` results are not itemised in the log, so those searches show "results not recorded". The model is not named in the log |

## How a session is matched to a workspace

Only the **first workspace folder** is watched. A log belongs to it when the path the log
records is inside the folder, or inside another **git worktree of the same repository**
(found through the `.git` file a worktree has). Logs of other projects are rejected after
reading a few records and remembered, so they are not looked at again.

## Adding an agent

An agent is a **source** (finds its logs) and a **parser** (reads them). Neither imports
`vscode`, so both are testable in plain Node.

1. **Look at real logs first.** Write a small script that lists the record types and the
   keys of each, and print a trimmed example of every interesting one. Do not guess a
   format; note the agent version you looked at.
2. **Write the parser** (`src/transcript/<agent>Transcript.ts`), implementing
   `RecordParser.feed(record) → ParsedRecord | null`:
   - build events with `EventBuilder` (`base`, `search`) from `common.ts`;
   - send shell commands through `shellEvents` (`shell.ts`) so `grep`/`sed -n`/`cat` become
     reads and searches with their hits;
   - use `unifiedDiffRange` if the log carries diffs;
   - emit `usage`, `meta` (`context`, `title`, `spawn`, `toolError`…) where the log has them;
   - read every field defensively and return events only for calls that succeeded.
3. **Write the source** (`src/transcript/<agent>Source.ts`), implementing
   `SessionSource.scan(ctx) → TailSpec[]`: list the agent's log folder, skip logs older than
   `ctx.cutoffMs` and ones `ctx.hasTail` already follows, decide whether each belongs to
   `ctx.root` with `belongsToWorkspace`, and return a `TailSpec` with a parser. Set
   `scanEveryMs` if the folder is large.
4. **Register it** in `SessionWatcher` (`sessionWatcher.ts`) and add its name to
   `ALL_SOURCES` and to the `spiderling.agentSources` setting in `package.json`.
5. **Test it** with synthetic records in the observed shapes (see
   `test/codexTranscript.test.js`), a discovery test with temp folders (see
   `test/sources.test.js`) and a watcher run (see `test/sessionWatcher.test.js`). Run the
   parser over every real log you have and check for exceptions and plausible counts.
6. **Document it** in this file and the README table.
