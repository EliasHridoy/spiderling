// The extension's activity event: one thing an agent did (read, edit, search,
// run a command), produced by the session-log parsers in src/transcript/*.
// 'call' is an MCP tool or subagent call: it has no file, only a target and a summary.
export type ActivityOp = 'read' | 'write' | 'search' | 'bash' | 'call';

// One match a search turned up (grep/rg/find output, or a search tool's result).
export interface SearchHit {
  file: string; // display path (workspace-relative when inside it, else absolute)
  line?: number;
  text?: string;
}

export interface ActivityEvent {
  ts: string;
  op: ActivityOp;
  // Display path: workspace-relative (POSIX) when inside the workspace, else
  // absolute. For a search it is the search root.
  file: string;
  agent: string;
  agentId: string;
  tool: string;
  // Line range / size of the call, when derivable (the same facts the terminal
  // shows, e.g. "read lines 1-200", "wrote 40 lines"). Absent for whole-file
  // reads or when the line couldn't be located.
  startLine?: number;
  endLine?: number;
  lines?: number;
  detail?: string;
  session: string;
  toolUseId: string;
  absFile?: string; // absolute path of `file`
  query?: string; // what a search looked for
  hits?: SearchHit[]; // first matches of a search (capped)
  hitCount?: number; // total matches, including the ones not in `hits`; absent when the log doesn't say
  callKind?: 'mcp' | 'agent'; // for op 'call'
  target?: string; // for op 'call': the MCP server, or the subagent type
  caption?: string; // what the agent said just before this step ("why")
}
