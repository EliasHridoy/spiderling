// Deterministic per-agent colors, so the same agent keeps the same spider color
// across the decorations, the tree view and the crawl map.
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#808000',
];

// "main" (the top-level session, not a subagent) gets a neutral gray so real
// agents stand out.
const MAIN_COLOR = '#9e9e9e';

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function colorForAgent(agent: string): string {
  if (agent === 'main') {
    return MAIN_COLOR;
  }
  return PALETTE[hash(agent) % PALETTE.length];
}
