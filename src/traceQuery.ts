// "Which agent steps touched this code?" over a parsed agent-trace.json. Pure
// functions (no `vscode` import) so the matching can be tested in plain Node.

export interface StepMatch {
  session: string;
  t: string;
  agent: string; // agent key as in the trace ('main', 'planner-fe:abc')
  agentLabel: string;
  op: 'read' | 'write';
  lines?: [number, number];
  detail?: string;
  symbol?: string;
  caption?: string;
  exact: boolean; // the step's line range overlaps the selection (not just the same file)
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

const MAX_MATCHES = 40;

// Steps of every session in `doc` that wrote (or read) `file` around lines
// `from`..`to` (1-based, inclusive). Edits that overlap the selection come
// first, newest first, then edits of the file with no recorded lines, then
// reads. `file` is the workspace-relative path the trace uses.
export function stepsTouching(doc: unknown, file: string, from: number, to: number): StepMatch[] {
  if (!isRec(doc) || !isRec(doc.sessions)) {
    return [];
  }
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const out: StepMatch[] = [];
  for (const [session, raw] of Object.entries(doc.sessions)) {
    if (!isRec(raw) || !Array.isArray(raw.steps)) {
      continue;
    }
    const agents = Array.isArray(raw.agents) ? raw.agents.filter(isRec) : [];
    const label = (key: string): string => {
      const a = agents.find((x) => x.key === key);
      const type = a && typeof a.type === 'string' ? a.type : key.split(':')[0];
      return a && typeof a.description === 'string' && a.description ? `${type} (${a.description})` : type;
    };
    for (const s of raw.steps) {
      if (!isRec(s) || s.file !== file || (s.op !== 'write' && s.op !== 'read') || typeof s.t !== 'string' || typeof s.agent !== 'string') {
        continue;
      }
      const lines = Array.isArray(s.lines) && s.lines.length === 2 && s.lines.every((n) => typeof n === 'number')
        ? ([s.lines[0], s.lines[1]] as [number, number])
        : undefined;
      if (lines && (lines[1] < lo || lines[0] > hi)) {
        continue; // a different part of the file
      }
      out.push({
        session,
        t: s.t,
        agent: s.agent,
        agentLabel: label(s.agent),
        op: s.op,
        lines,
        detail: typeof s.detail === 'string' ? s.detail : undefined,
        symbol: typeof s.symbol === 'string' ? s.symbol : undefined,
        caption: typeof s.caption === 'string' ? s.caption : undefined,
        exact: !!lines,
      });
    }
  }
  const rank = (m: StepMatch) => (m.op === 'write' ? (m.exact ? 0 : 1) : m.exact ? 2 : 3);
  out.sort((a, b) => rank(a) - rank(b) || b.t.localeCompare(a.t));
  return out.slice(0, MAX_MATCHES);
}
