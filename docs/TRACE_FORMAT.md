# Trace format

A trace is a JSON file. By default each session is written to its own file,
`.spiderling/traces/<session-id>.json`; with `spiderling.traceNextToIssueDocs`, sessions
that worked in an issue folder are merged into `docs/<number>/agent-trace.json`
(one file per issue, every session that worked on it). A sample is in
[`examples/demo-trace.json`](../examples/demo-trace.json).

The format is **versioned by its `schema` id** (`spiderling.agent-trace/v1`). Within a
version, fields are only ever *added*, so a reader must ignore fields it does not know.
Files written by earlier builds with the id `amlog.agent-trace/v1` have the same shape and
are still read and merged.

## What is stored, and what is not

Stored: paths, line ranges, search queries, the *paths* a search found, one-line
explanations the agent wrote, failed-call counts, token and cost metrics.

Never stored: file contents, tool output, matched text, the agent's hidden reasoning.
Free text goes through credential masking first (`redactions` counts the values masked),
and paths under the home directory are written as `~`.

## Shape

```jsonc
{
  "schema": "spiderling.agent-trace/v1",
  "issue": "42",                      // docs/<n>/ folder number, or null
  "sessions": {                       // keyed by session id, oldest first
    "<session-id>": {
      "title": "Add VAT to invoice totals",
      "source": "claude",             // claude | codex | antigravity
      "branch": "feat/42-invoice-vat",
      "redactions": 0,
      "startedAt": "2026-03-04T09:00:14.000Z",
      "endedAt":   "2026-03-04T09:12:53.000Z",
      "pr": { "number": 57, "url": "https://…", "repository": "owner/repo" },   // when the log says
      "metrics": {
        "costUSD": 3.42,              // when the log says
        "durationMs": 759000,
        "linesAdded": 42, "linesRemoved": 9,
        "tokens": { "<model>": { "input": 0, "output": 0, "cacheRead": 0, "cacheCreate": 0, "messages": 0 } }
      },
      "agents": [
        {
          "key": "planner:p1a2b3",    // "main", or "<type>:<id>" for a subagent
          "type": "planner",
          "description": "Plan VAT for invoices",
          "startedAt": "…", "endedAt": "…", "durationMs": 0,
          "steps": 8,
          "errors": 2,                // failed tool calls; omitted when 0
          "tokens": { "<model>": { … } }
        }
      ],
      "steps": [ /* see below, oldest first */ ]
    }
  }
}
```

### Steps

| Field | Meaning |
| --- | --- |
| `t` | ISO time the step finished |
| `agent` | An `agents[].key` |
| `op` | `read`, `write`, `search`, `call` (an MCP tool or subagent call) or `bash` (a command that is none of the others) |
| `file` | The file, workspace-relative with `/` separators when inside the workspace, otherwise absolute (`~/…` under the home directory). For a search: where it searched. `(bash)` for a plain command |
| `lines` | `[first, last]` read or changed, when known |
| `detail` | Short description, e.g. `edited 10 line(s) @ line 52`, `sed lines 40-92`, `$ npm test` |
| `query` | What a search looked for |
| `hits` | How many matches a search found; **absent** when the agent's log does not say (not the same as `0`) |
| `hitFiles` | Distinct paths a search found (at most 25) |
| `symbol` | The function/class around the lines, from the CodeGraph index (steps captured live only) |
| `callKind`, `target` | For `call` steps: `mcp` or `agent`, and the MCP server or subagent type |
| `caption` | What the agent wrote just before this step: its stated reason |

Steps of one tool call (for example `grep … && sed -n …`) share a timestamp; they are
listed in the order the command performed them.

## Writing a reader

- Iterate `sessions`, then `steps`; treat unknown `op` values and fields as ignorable.
- Do not assume `lines`, `hits`, `symbol` or `caption` exist.
- `agent` keys are stable within a file; the same agent type in two sessions gets two ids.
- To interpret a trace (phases, what led to a step, drift signals) you can reuse
  [`media/traceAnalysis.js`](../media/traceAnalysis.js): a plain script, no dependencies.
