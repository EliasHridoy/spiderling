# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [0.1.0]: first public release

Spiderling started as the spider-crawler extension of an agent workflow toolkit and is now
a standalone project: nothing needs installing in the agents.

### Capture
- Follows **Claude Code**, **Codex CLI** and **Antigravity CLI** sessions by reading their
  own logs, for the open folder and for other git worktrees of the same repository.
- Reads and edits with exact lines, shell reads/searches (`grep`, `sed -n`, `cat`, `find`,
  redirects, heredocs), search hits, subagents, the agent's own explanation of each step,
  failed tool calls, tokens, cost and the pull request it opened.

### Views
- **Code Crawl:** one live lane per agent; the spider walks the exact lines, types searches
  into a search box, walks the hits and follows a hit into the file; busy agents are
  followed file by file without falling behind.
- **Crawl Map** with a full recap, an Explorer view, a status bar item and a gutter spider.
- **Trace Replay:** timeline per agent, phases, what led to each step, signals worth a look,
  a Flow view, function names for live edits; **Show Agent Trace for This Code**; HTML
  export; markdown summary for a PR.

### Traces
- One JSON file per session in `.spiderling/traces/` (a folder that ignores itself in git),
  or per issue in `docs/<n>/agent-trace.json` with `spiderling.traceNextToIssueDocs`.
- Credential masking; home directory written as `~`; files and folders stay local.
- Reads and merges traces written by earlier builds (`amlog.agent-trace/v1`).

### Changed from the earlier extension
- Commands, settings and view ids are now `spiderling.*`.
- The Claude Code hook is gone: Claude sessions in other worktrees are found from the
  working directory recorded in each log instead.
- Traces go to `.spiderling/traces/` by default; writing next to `docs/<n>/` is opt-in.

[0.1.0]: https://github.com/EliasHridoy/spiderling/releases/tag/v0.1.0
