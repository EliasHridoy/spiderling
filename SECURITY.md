# Security

## What Spiderling touches

- It **reads** local session logs of AI coding agents (`~/.claude`, `~/.codex`,
  `~/.gemini`) and, for naming functions, a repository's local CodeGraph index (read-only).
- It **writes** trace files into the workspace (`.spiderling/traces/` by default).
- It makes **no network requests** and has no telemetry or accounts.
- Traces store paths, line ranges, queries, short explanations and metrics, never file
  contents or tool output, and credentials are masked before writing. Masking is
  pattern-based and best-effort: skim a trace before sharing it outside your team.

## Reporting a vulnerability

Please report security problems privately through GitHub:
**Security → Report a vulnerability** on
<https://github.com/EliasHridoy/spiderling/security/advisories/new>.
Do not open a public issue for something exploitable. Expect an acknowledgement within a
few days.

Examples worth reporting: a way to make Spiderling write outside its trace folder, execute
something from a crafted log or trace file, leak a credential that the masking is meant to
catch, or read logs of other projects.
