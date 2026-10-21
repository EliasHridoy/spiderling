const test = require('node:test');
const assert = require('node:assert/strict');
const { LivePlayer, laneKey } = require('../out/livePlayer.js');

const ev = (over = {}) => ({ ts: 't', op: 'read', file: 'a.ts', agent: 'main', agentId: '', tool: 'Read', session: 's', toolUseId: 't', ...over });

// The player schedules with setTimeout and Date.now, so run it on a fake clock.
// Time is advanced in small steps, as it passes in reality: one huge tick would
// fire the timers without moving Date.now() along with them.
function player() {
  test.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const played = [];
  const p = new LivePlayer((s) => played.push(s));
  const tick = (ms) => {
    for (let left = ms; left > 0; left -= 50) test.mock.timers.tick(Math.min(50, left));
  };
  return { p, played, tick };
}
test.afterEach(() => test.mock.timers.reset());

test('the first step of an idle lane plays immediately at full length', () => {
  const { p, played } = player();
  p.push(ev());
  assert.equal(played.length, 1);
  assert.equal(played[0].durationMs, 1500);
  assert.equal(played[0].queued, 0);
  assert.equal(played[0].lane, 'main');
  p.dispose();
});

test('steps in one lane play one at a time, each after the previous one finished', () => {
  const { p, played, tick } = player();
  p.push(ev({ file: 'a.ts' }));
  p.push(ev({ file: 'b.ts' }));
  assert.deepEqual(played.map((s) => s.file), ['a.ts']);
  tick(1499);
  assert.equal(played.length, 1);
  tick(1);
  assert.deepEqual(played.map((s) => s.file), ['a.ts', 'b.ts']);
  p.dispose();
});

test('a backlog plays faster, but never faster than the minimum', () => {
  const { p, played, tick } = player();
  for (let i = 0; i < 20; i++) p.push(ev({ file: `f${i}.ts` }));
  tick(100000);
  assert.equal(played.length, 20);
  assert.equal(played[0].durationMs, 1500);
  assert.ok(played[1].durationMs < 1500, 'queued steps are sped up');
  assert.ok(played.every((s) => s.durationMs >= 350));
  p.dispose();
});

test('a lane that falls far behind drops its oldest steps and keeps the newest', () => {
  const { p, played, tick } = player();
  for (let i = 0; i < 60; i++) p.push(ev({ file: `f${i}.ts` }));
  tick(1000000);
  assert.equal(played.length, 25); // the one already playing + the 24 newest
  assert.equal(played[0].file, 'f0.ts');
  assert.equal(played[played.length - 1].file, 'f59.ts');
  assert.ok(!played.some((s) => s.file === 'f1.ts'));
  p.dispose();
});

test('agents have independent lanes, keyed by instance when there is an id', () => {
  const { p, played } = player();
  p.push(ev({ agent: 'main' }));
  p.push(ev({ agent: 'planner', agentId: 'a1' }));
  p.push(ev({ agent: 'planner', agentId: 'a2' }));
  assert.deepEqual(played.map((s) => s.lane), ['main', 'a1', 'a2']);
  assert.equal(laneKey(ev({ agent: 'planner', agentId: 'a1' })), 'a1');
  assert.equal(laneKey(ev()), 'main');
  p.dispose();
});

test('writes and searches get their own base durations; commands are not played', () => {
  const { p, played } = player();
  p.push(ev({ agent: 'a', op: 'write' }));
  p.push(ev({ agent: 'b', op: 'search', hits: [] }));
  p.push(ev({ agent: 'c', op: 'bash', file: '(bash)' }));
  assert.deepEqual(played.map((s) => [s.op, s.durationMs]), [['write', 2000], ['search', 2600]]);
  p.dispose();
});

test('opening a search hit is linked back to that hit', () => {
  const { p, played, tick } = player();
  p.push(ev({ op: 'search', tool: 'grep', file: 'src', hits: [{ file: 'x/other.ts', line: 3 }, { file: 'src/a.ts', line: 130 }, { file: 'src/a.ts', line: 400 }] }));
  p.push(ev({ file: 'src/a.ts', startLine: 120, endLine: 150 }));
  tick(5000);
  const read = played[1];
  assert.equal(read.fromHit, 1);
  assert.equal(read.hitLine, 130);
  p.dispose();
});

test('a read of a file the search did not return is not linked', () => {
  const { p, played, tick } = player();
  p.push(ev({ op: 'search', tool: 'grep', file: 'src', hits: [{ file: 'src/a.ts', line: 1 }] }));
  p.push(ev({ file: 'src/unrelated.ts' }));
  tick(5000);
  assert.equal(played[1].fromHit, undefined);
  p.dispose();
});

test('a read outside every hit line falls back to the first hit in that file', () => {
  const { p, played, tick } = player();
  p.push(ev({ op: 'search', tool: 'grep', file: 'src', hits: [{ file: 'src/a.ts', line: 500 }] }));
  p.push(ev({ file: 'src/a.ts', startLine: 1, endLine: 20 }));
  tick(5000);
  assert.equal(played[1].fromHit, 0);
  p.dispose();
});

test('clear() cancels what is still waiting', () => {
  const { p, played, tick } = player();
  p.push(ev({ file: 'a.ts' }));
  p.push(ev({ file: 'b.ts' }));
  p.clear();
  tick(10000);
  assert.deepEqual(played.map((s) => s.file), ['a.ts']);
});
