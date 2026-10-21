const test = require('node:test');
const assert = require('node:assert/strict');
const { stepsTouching } = require('../out/traceQuery.js');

const step = (t, agent, op, file, lines, extra = {}) => ({ t, agent, op, file, lines, ...extra });
const doc = {
  sessions: {
    s1: {
      agents: [{ key: 'main', type: 'main' }, { key: 'planner:a1', type: 'planner', description: 'Plan it' }],
      steps: [
        step('2026-10-18T07:00:00.000Z', 'main', 'read', 'src/a.ts', [1, 200]),
        step('2026-10-18T07:05:00.000Z', 'planner:a1', 'write', 'src/a.ts', [130, 131], { symbol: 'mapLinks', caption: 'Fix the mapping' }),
        step('2026-10-18T07:10:00.000Z', 'main', 'write', 'src/a.ts', [500, 510]),
        step('2026-10-18T07:15:00.000Z', 'main', 'write', 'src/a.ts', undefined, { detail: 'edited' }),
        step('2026-10-18T07:20:00.000Z', 'main', 'write', 'src/other.ts', [130, 131]),
        step('2026-10-18T07:25:00.000Z', 'main', 'search', 'src/a.ts', undefined, { query: 'x' }),
      ],
    },
    s2: { steps: [step('2026-10-19T09:00:00.000Z', 'main', 'write', 'src/a.ts', [128, 140], { caption: 'later tweak' })] },
  },
};

test('edits that overlap the selection come first, newest first; other parts of the file are left out', () => {
  const m = stepsTouching(doc, 'src/a.ts', 130, 131);
  assert.deepEqual(m.map((x) => [x.session, x.op, x.exact, x.lines && x.lines.join('-')]), [
    ['s2', 'write', true, '128-140'],
    ['s1', 'write', true, '130-131'],
    ['s1', 'write', false, undefined],
    ['s1', 'read', true, '1-200'],
  ]);
});

test('a match carries what the replay and the picker need', () => {
  const m = stepsTouching(doc, 'src/a.ts', 130, 130).find((x) => x.session === 's1' && x.symbol);
  assert.deepEqual([m.agent, m.agentLabel, m.symbol, m.caption, m.t], ['planner:a1', 'planner (Plan it)', 'mapLinks', 'Fix the mapping', '2026-10-18T07:05:00.000Z']);
  assert.equal(stepsTouching(doc, 'src/a.ts', 128, 140).find((x) => x.session === 's2').agentLabel, 'main');
});

test('a selection given backwards, or a single line, works', () => {
  assert.equal(stepsTouching(doc, 'src/a.ts', 131, 130).filter((x) => x.op === 'write' && x.exact).length, 2);
  assert.equal(stepsTouching(doc, 'src/a.ts', 505, 505).filter((x) => x.exact && x.op === 'write').length, 1);
});

test('searches, other files and junk are ignored', () => {
  assert.deepEqual(stepsTouching(doc, 'src/nothing.ts', 1, 9), []);
  assert.ok(stepsTouching(doc, 'src/a.ts', 1, 9999).every((x) => x.op === 'write' || x.op === 'read'));
  assert.deepEqual(stepsTouching(null, 'a', 1, 2), []);
  assert.deepEqual(stepsTouching({ sessions: 'x' }, 'a', 1, 2), []);
  assert.deepEqual(stepsTouching({ sessions: { s: { steps: [null, 'x', { file: 'a' }, { t: 't', agent: 'm', op: 'write' }] } } }, 'a', 1, 2), []);
});

test('the list is capped', () => {
  const steps = Array.from({ length: 100 }, (_, i) => step(`2026-10-18T07:${String(i % 60).padStart(2, '0')}:00.000Z`, 'main', 'write', 'f.ts', [1, 2]));
  assert.equal(stepsTouching({ sessions: { s: { steps } } }, 'f.ts', 1, 2).length, 40);
});
