# Roadmap

What exists, what is planned, and what is deliberately not planned. Items under "Ideas"
are possibilities, not promises; open an issue if one matters to you.

## Now (0.1)

- Live view, overview/recap, replay, HTML export, PR summary, "trace for this code".
- Claude Code, Codex CLI and Antigravity CLI.
- Credential masking, local-only traces, git-worktree-aware session matching.

## Next

- **Publish.** VS Code Marketplace and Open VSX (the release workflow already packages a
  VSIX and publishes when the tokens are configured; see CONTRIBUTING).
- **Verify in more setups.** Windows and macOS runs, multi-root workspaces (today only the
  first folder is watched), remote/SSH/WSL workspaces (logs live on the remote side).
- **Keep up with the agents.** Re-check the log formats against new releases of each
  agent and fix what moved; this is ongoing work, not a one-off.
- **Replay polish.** Keyboard navigation of the step list, filtering by file or phase,
  remembering the last position per trace.

## Ideas

- **More agents.** Gemini CLI, OpenCode, Aider, Cursor's agent logs; each needs a real look
  at its logs first (see [AGENT_SUPPORT.md](AGENT_SUPPORT.md#adding-an-agent)).
- **Diff-aware replay.** Open the replay from a git diff or a pull request: for every hunk,
  the steps that wrote it.
- **Compare two runs.** Same task, two agents or two prompts: phases and flow side by side.
- **Better phases.** Let a project say which agent names mean plan/implement/verify, instead
  of inferring from names and commands.
- **Search across traces.** "Which sessions touched this file?"
- **A standalone viewer.** The exported HTML already works without the extension; a small
  CLI that turns a log into a trace would let CI attach one to a pull request.

## Not planned

- **Controlling agents.** Spiderling observes; it does not start, stop, approve or steer them.
- **Sending data anywhere.** No telemetry, no accounts, no hosted service.
- **Capturing terminal output.** The agents' own logs are structured and complete; a
  terminal scrape would be less reliable and not agent-aware.
