const test = require('node:test');
const assert = require('node:assert/strict');
const { RecapPlayer, stepToEvent } = require('../out/recapPlayer.js');

const step = (over = {}) => ({ t: '2026-01-01T00:00:00Z', agent: 'main', op: 'read', file: 'a.ts', ...over });
const events = (steps) => steps.map((s) => stepToEvent(s, 'sess')).filter(Boolean);

test('a saved step becomes a playable event; commands are left out', () => {
  const e = stepToEvent(step({ agent: 'planner:p1a2b3', op: 'write', lines: [10, 14], detail: 'edited 5 line(s) @ line 10' }), 's');
  assert.deepEqual([e.agent, e.agentId, e.op, e.startLine, e.endLine, e.lines], ['planner', 'p1a2b3', 'write', 10, 14, 5]);
  assert.equal(stepToEvent(step({ op: 'bash', file: '(bash)' }), 's'), undefined);
  assert.equal(stepToEvent({ nonsense: true }, 's'), undefined);
});

test('a search keeps its query, hit count and the files it found; a call keeps its target', () => {
  const s = stepToEvent(step({ op: 'search', query: 'vat', hits: 2, hitFiles: ['a.ts', 'b.ts'], detail: 'grep "vat" → 2 hit(s)' }), 's');
  assert.deepEqual([s.query, s.hitCount, s.hits.map((h) => h.file), s.tool], ['vat', 2, ['a.ts', 'b.ts'], 'grep']);
  const c = stepToEvent(step({ op: 'call', file: '(mcp)', callKind: 'mcp', target: 'Linear', query: 'team: web', detail: 'Linear · list_issues' }), 's');
  assert.deepEqual([c.callKind, c.target, c.tool, c.query], ['mcp', 'Linear', 'list_issues', 'team: web']);
});

function player(steps) {
  test.mock.timers.enable({ apis: ['setTimeout'] });
  const played = [];
  const states = [];
  const p = new RecapPlayer(events(steps), (s) => played.push(s), (s) => states.push(s));
  return { p, played, states };
}
test.afterEach(() => test.mock.timers.reset());

test('steps play in recorded order, one at a time, at the chosen speed', () => {
  const { p, played, states } = player([step({ file: 'a.ts' }), step({ file: 'b.ts', agent: 'x:1' }), step({ file: 'c.ts' })]);
  p.play();
  assert.deepEqual(played.map((s) => s.file), ['a.ts']);
  assert.equal(played[0].durationMs, 1500);
  test.mock.timers.tick(1500);
  assert.deepEqual(played.map((s) => s.file), ['a.ts', 'b.ts']);
  assert.equal(played[1].lane, '1');
  p.setSpeed(8);
  test.mock.timers.tick(1500);
  assert.equal(played[2].durationMs, 220); // 1500/8 is under the minimum step length
  test.mock.timers.tick(1000);
  assert.equal(states[states.length - 1].playing, false);
  assert.equal(states[states.length - 1].index, 3);
  p.dispose();
});

test('pause stops the clock; seek resets the lanes and carries on from there', () => {
  const { p, played } = player([step({ file: 'a.ts' }), step({ file: 'b.ts' }), step({ file: 'c.ts' })]);
  p.play();
  p.pause();
  test.mock.timers.tick(10000);
  assert.equal(played.length, 1);
  let resets = 0;
  p.seek(2, () => resets++);
  assert.equal(resets, 1);
  p.play();
  assert.equal(played[1].file, 'c.ts');
  p.dispose();
});

test('a read that opens a hit of the lane\'s last search is linked to it', () => {
  const { p, played } = player([step({ op: 'search', query: 'q', hits: 2, hitFiles: ['x.ts', 'y.ts'] }), step({ file: 'y.ts' })]);
  p.play();
  test.mock.timers.tick(3000);
  assert.equal(played[1].fromHit, 1);
  p.dispose();
});
