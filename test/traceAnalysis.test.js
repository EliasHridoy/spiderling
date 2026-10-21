const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../media/traceAnalysis.js');

// ---- builders --------------------------------------------------------------------
let clock = Date.parse('2026-10-18T07:00:00.000Z');
const tick = (ms = 10000) => { clock += ms; return new Date(clock).toISOString(); };
const step = (op, file, over = {}) => ({ t: tick(), agent: 'main', op, file, ...over });
const read = (file, over) => step('read', file, over);
const write = (file, over) => step('write', file, over);
const search = (query, over) => step('search', 'src', { query, hits: 0, ...over });
const bash = (detail, over) => step('bash', '(bash)', { detail, ...over });
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

// ---- classification ------------------------------------------------------------------

test('agent names say which phase their steps belong to', () => {
  const r = (k) => A.roleOf(k);
  assert.equal(r('planner-fe:abc'), 'plan');
  assert.equal(r('researcher'), 'explore');
  assert.equal(r('Explore'), 'explore');
  assert.equal(r('implementor-be'), 'implement');
  assert.equal(r('review'), 'verify');
  assert.equal(r('test-generator'), 'verify');
  assert.equal(r('browser-launcher'), 'verify');
  assert.equal(r('bug-triage'), 'verify');
  assert.equal(r('github-manager'), null, 'it starts an issue as well as shipping it');
  assert.equal(r('main'), null);
  assert.equal(r('codex'), null);
  assert.equal(r('general-purpose:x'), null);
});

test('without a role, the operation decides', () => {
  assert.equal(A.classify(read('src/a.ts')), 'explore');
  assert.equal(A.classify(search('x')), 'explore');
  assert.equal(A.classify(write('src/a.ts')), 'implement');
  assert.equal(A.classify(write('docs/12/plan.md')), 'plan');
  assert.equal(A.classify(write('docs/stories/s1.md')), 'plan');
  assert.equal(A.classify(write('docs/12/other-notes.md')), 'implement');
  assert.equal(A.classify(bash('$ dotnet test')), 'verify');
  assert.equal(A.classify(bash('$ npm run lint')), 'verify');
  assert.equal(A.classify(bash('$ git commit -m x')), 'ship');
  assert.equal(A.classify(bash('$ gh pr create')), 'ship');
  assert.equal(A.classify(bash('$ gh issue view 12')), null);
  assert.equal(A.classify(bash('$ git checkout -b feat/x', { agent: 'github-manager:g' })), null);
  assert.equal(A.classify(bash('$ git push', { agent: 'github-manager:g' })), 'ship');
  assert.equal(A.classify(bash('$ npm install')), null);
  assert.equal(A.classify(read('x.ts', { agent: 'planner-fe:a' })), 'plan');
});

// ---- phases -----------------------------------------------------------------------------

test('a clean explore -> implement -> verify -> ship run becomes four phases', () => {
  const steps = [
    ...many(12, (i) => (i % 3 ? read(`src/f${i}.ts`) : search('thing'))),
    ...many(10, (i) => (i % 2 ? write('src/a.ts') : read('src/a.ts'))),
    bash('$ dotnet test'), bash('$ dotnet test'), bash('$ npm run lint'), bash('$ npm run build'),
    bash('$ git commit -m x'), bash('$ git push'), bash('$ gh pr create'),
  ];
  const ph = A.phases(steps);
  assert.deepEqual(ph.map((p) => p.kind), ['explore', 'implement', 'verify', 'ship']);
  assert.equal(ph[0].from, 0);
  assert.equal(ph[ph.length - 1].to, steps.length - 1);
  assert.deepEqual(ph.map((p) => p.count).reduce((a, b) => a + b), steps.length);
});

test('phases tile the steps exactly and carry their facts', () => {
  const steps = [...many(8, (i) => read(`src/f${i % 2}.ts`)), ...many(8, () => write('src/hot.ts', { symbol: 'hot' }))];
  const ph = A.phases(steps);
  let next = 0;
  for (const p of ph) {
    assert.equal(p.from, next);
    next = p.to + 1;
  }
  assert.equal(next, steps.length);
  const impl = ph.find((p) => p.kind === 'implement');
  assert.equal(impl.writes, 8);
  assert.equal(impl.topFiles[0], 'src/hot.ts');
  assert.deepEqual(impl.agents, ['main']);
  assert.ok(impl.activeMs > 0);
});

test('parallel agents do not shatter the phases: steps vote with their neighbours', () => {
  // two agents interleaved in time: a planner reading and an implementor writing
  const steps = [];
  for (let i = 0; i < 20; i++) {
    steps.push(read(`src/p${i}.ts`, { agent: 'planner-fe:a' }));
    steps.push(write(`src/w${i}.ts`, { agent: 'implementor-fe:b' }));
  }
  const ph = A.phases(steps);
  assert.ok(ph.length <= 3, `expected few phases, got ${ph.map((p) => p.kind)}`);
});

test('a stray edit among reads is not a phase; a closing burst of tests is', () => {
  const steps = [...many(10, (i) => read(`f${i}.ts`)), write('a.ts'), ...many(10, (i) => read(`g${i}.ts`))];
  assert.deepEqual(A.phases(steps).map((p) => p.kind), ['explore'], 'one stray edit is not a phase');
  const withTests = [...many(12, (i) => write(`a${i}.ts`)), bash('$ npm test'), bash('$ npm test'), bash('$ npm test')];
  assert.deepEqual(A.phases(withTests).map((p) => p.kind), ['implement', 'verify']);
});

test('phases are capped and empty input is fine', () => {
  assert.deepEqual(A.phases([]), []);
  const steps = [];
  const kinds = ['read', 'write', 'bash'];
  for (let blk = 0; blk < 40; blk++) {
    for (let i = 0; i < 6; i++) steps.push(kinds[blk % 3] === 'bash' ? bash('$ npm test') : step(kinds[blk % 3], `f${blk}.ts`));
  }
  assert.ok(A.phases(steps).length <= 14);
});

test('idle time is not counted as active time', () => {
  const a = read('a.ts');
  clock += 3 * 3600e3;
  const b = read('b.ts');
  const ph = A.phases([a, b, read('c.ts'), read('d.ts'), read('e.ts')]);
  assert.ok(ph[0].activeMs < 60000);
});

// ---- edges ----------------------------------------------------------------------------------

test('opening a file a search found links the search to the step', () => {
  const steps = [
    search('finish_to_start', { hits: 3, hitFiles: ['src/g.ts', 'src/h.ts'] }),
    read('src/unrelated.ts'),
    read('src/g.ts', { lines: [120, 150] }),
    write('src/h.ts', { lines: [3, 4] }),
  ];
  const e = A.edges(steps);
  assert.deepEqual(e.opened, [{ search: 0, step: 2, file: 'src/g.ts' }, { search: 0, step: 3, file: 'src/h.ts' }]);
});

test('a search only leads to files for the same agent, and the most recent search wins', () => {
  const steps = [
    search('a', { hitFiles: ['src/x.ts'], hits: 1 }),
    search('b', { hitFiles: ['src/x.ts'], hits: 1 }),
    search('c', { hitFiles: ['src/x.ts'], hits: 1, agent: 'codex' }),
    read('src/x.ts'),
    read('src/x.ts', { agent: 'codex' }),
  ];
  assert.deepEqual(A.edges(steps).opened, [{ search: 1, step: 3, file: 'src/x.ts' }, { search: 2, step: 4, file: 'src/x.ts' }]);
});

test('an edit is linked to the files read (and searches run) since the previous edit', () => {
  const steps = [
    search('q1', { hitFiles: [], hits: 0 }),
    read('src/a.ts'), read('src/b.ts'), read('src/a.ts'),
    write('src/c.ts'),
    read('src/d.ts'),
    write('src/c.ts'),
  ];
  const { context } = A.edges(steps);
  assert.equal(context.length, 2);
  assert.deepEqual(context[0].reads.map((r) => r.file), ['src/b.ts', 'src/a.ts']); // distinct, in order
  assert.deepEqual(context[0].searches, [0]);
  assert.deepEqual(context[1].reads.map((r) => r.file), ['src/d.ts']);
  assert.deepEqual(context[1].searches, []);
});

test('old traces without hit files give no opened-hit edges but still work', () => {
  const steps = [search('x', { hits: 4 }), read('src/a.ts'), write('src/a.ts')];
  const e = A.edges(steps);
  assert.deepEqual(e.opened, []);
  assert.equal(e.context.length, 1);
});

// ---- drift -----------------------------------------------------------------------------------

const kinds = (d) => d.map((x) => x.kind);

test('re-reading the same file many times is flagged, more strongly when extreme', () => {
  const d4 = A.drift(many(4, () => read('src/a.ts')), []);
  assert.deepEqual([d4[0].kind, d4[0].level, d4[0].count], ['reread', 'info', 4]);
  const d9 = A.drift(many(9, () => read('src/a.ts')), []);
  assert.equal(d9[0].level, 'warn');
  assert.deepEqual(d9[0].steps.length, 9);
  assert.deepEqual(A.drift(many(3, () => read('src/a.ts')), []), []);
  assert.deepEqual(A.drift([...many(3, () => read('a.ts')), ...many(3, () => read('a.ts', { agent: 'codex' }))], []), [], 'counted per agent');
});

test('editing one file again and again, and rewriting the same lines', () => {
  const churn = A.drift(many(5, () => write('src/a.ts', { lines: [1, 5] })), []);
  assert.ok(kinds(churn).includes('churn'));
  assert.ok(kinds(churn).includes('rewrite'));
  assert.equal(churn.find((x) => x.kind === 'rewrite').level, 'warn');
  const spread = A.drift(many(5, (i) => write('src/a.ts', { lines: [i * 100, i * 100 + 5] })), []);
  assert.ok(kinds(spread).includes('churn'));
  assert.ok(!kinds(spread).includes('rewrite'), 'different lines are not a rewrite');
});

test('searches that keep coming up empty, and the same search repeated', () => {
  const blind = A.drift(many(4, (i) => search(`q${i}`, { hits: 0 })), []);
  assert.deepEqual(kinds(blind), ['blind']);
  const found = A.drift([search('a', { hits: 0 }), search('b', { hits: 0 }), search('c', { hits: 2 }), search('d', { hits: 0 }), search('e', { hits: 0 })], []);
  assert.deepEqual(found, []);
  const rep = A.drift(many(3, () => search('SameQuery', { hits: 2 })), []);
  assert.deepEqual(kinds(rep), ['repeat']);
  assert.match(rep[0].title, /samequery/);
  const unknown = A.drift(many(5, () => search('x', { hits: undefined })), []);
  assert.ok(!kinds(unknown).includes('blind'), 'unknown results are not "found nothing"');
});

test('failed tool calls and long idle time', () => {
  const agents = [{ key: 'planner:a', type: 'planner', description: 'Plan it', steps: 20, errors: 12 }, { key: 'main', type: 'main', steps: 100, errors: 3 }];
  const d = A.drift([read('a.ts')], agents);
  assert.deepEqual([d[0].kind, d[0].level, d[0].count], ['errors', 'warn', 12]);
  assert.equal(d[0].detail, 'planner (Plan it)');
  const a = read('a.ts');
  clock += 2 * 3600e3;
  const idle = A.drift([a, read('b.ts')], []);
  assert.deepEqual(kinds(idle), ['idle']);
  assert.match(idle[0].title, /Idle for 2h/);
});

test('findings are ordered: warnings first, then by size, capped', () => {
  const steps = [...many(9, () => read('r.ts')), ...many(4, () => read('s.ts')), ...many(7, () => write('w.ts'))];
  const d = A.drift(steps, []);
  assert.equal(d[0].level, 'warn');
  const levels = d.map((x) => x.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => (a === b ? 0 : a === 'warn' ? -1 : 1)));
  const lots = [];
  for (let f = 0; f < 30; f++) lots.push(...many(5, () => read(`f${f}.ts`)));
  assert.ok(A.drift(lots, []).length <= 12);
});

// ---- flow --------------------------------------------------------------------------------------

test('flow links queries to the files they led to, and files read to files edited', () => {
  const steps = [
    search('link types', { hits: 2, hitFiles: ['src/g.ts'] }),
    read('src/g.ts'), read('src/h.ts'),
    write('src/c.ts', { symbol: 'mapLinks' }),
  ];
  const f = A.flow(steps, steps.length - 1);
  assert.deepEqual(f.queries.map((q) => [q.id, q.label, q.n]), [['q0', 'link types', 1]]);
  assert.deepEqual(f.reads.map((r) => r.id).sort(), ['r:src/g.ts', 'r:src/h.ts']);
  assert.deepEqual(f.writes.map((w) => [w.id, w.symbol]), [['w:src/c.ts', 'mapLinks']]);
  const key = (l) => `${l.from}>${l.to}:${l.kind}`;
  assert.deepEqual(f.links.map(key).sort(), ['q0>r:src/g.ts:opened', 'r:src/g.ts>w:src/c.ts:context', 'r:src/h.ts>w:src/c.ts:context']);
});

test('flow only covers the steps up to the playhead', () => {
  const steps = [read('src/a.ts'), write('src/b.ts'), read('src/later.ts'), write('src/later-edit.ts')];
  const f = A.flow(steps, 1);
  assert.deepEqual(f.reads.map((r) => r.file), ['src/a.ts']);
  assert.deepEqual(f.writes.map((w) => w.file), ['src/b.ts']);
  assert.deepEqual(A.flow([], 0), { queries: [], reads: [], writes: [], links: [] });
});

test('flow is bounded', () => {
  const steps = [];
  for (let i = 0; i < 60; i++) steps.push(read(`r${i}.ts`));
  for (let i = 0; i < 40; i++) steps.push(write(`w${i}.ts`));
  const f = A.flow(steps, steps.length - 1);
  assert.ok(f.reads.length <= 14 && f.writes.length <= 10 && f.queries.length <= 10);
});

// ---- markdown summary ----------------------------------------------------------------------------------

test('the PR summary names phases, edits (with symbols), metrics and what is worth a look', () => {
  const steps = [...many(8, (i) => read(`src/f${i}.ts`)), ...many(5, () => write('src/hot.ts', { symbol: 'parseInvoice' })), bash('$ dotnet test'), bash('$ dotnet test')];
  const doc = {
    issue: '2793',
    sessions: {
      s1: {
        title: 'Dependencies', source: 'claude',
        metrics: { durationMs: 3 * 3600e3, costUSD: 12.5, linesAdded: 40, linesRemoved: 7, tokens: { m: { input: 1000, output: 2000 } } },
        agents: [{ key: 'main', type: 'main', steps: steps.length }],
        steps,
      },
    },
  };
  const md = A.markdown(doc, 's1');
  assert.match(md, /^### Agent trace for #2793: Dependencies/);
  assert.match(md, /claude · 1 agent\(s\) · 15 steps · 3h 0m · \$12\.50 · 3k tokens · \+40 \/ -7 lines/);
  assert.match(md, /\*\*Phases:\*\* explore .* → implement/);
  assert.match(md, /`src\/hot\.ts` \(5 edits, in `parseInvoice`\)/);
  assert.match(md, /\*\*Worth a look:\*\*\n- Edited src\/hot\.ts 5 times/);
  assert.equal(A.markdown({ sessions: {} }), '');
  assert.ok(A.markdown(doc).includes('Dependencies'), 'defaults to the latest session');
});

test('a minimal trace still summarises', () => {
  const doc = { issue: null, sessions: { s: { steps: [read('a.ts')], agents: [], metrics: {} } } };
  const md = A.markdown(doc, 's');
  assert.match(md, /^### Agent trace/);
  assert.ok(!md.includes('Worth a look'));
});

test('a brief look around between two stretches of implementing is part of implementing', () => {
  const impl = () => many(8, (i) => write(`src/a${i}.ts`));
  const steps = [...impl(), ...many(6, (i) => read(`src/look${i}.ts`)), ...impl()];
  assert.deepEqual(A.phases(steps).map((p) => p.kind), ['implement']);
  // but a long stretch of exploring in between is its own phase
  const first = impl();
  clock += 40 * 60 * 1000;
  const looking = many(6, (i) => { clock += 20 * 60 * 1000; return read(`src/look${i}.ts`); });
  assert.deepEqual(A.phases([...first, ...looking, ...impl()]).map((p) => p.kind), ['implement', 'explore', 'implement']);
});

test('notes and plans are rewritten as they are refined: not churn, unlike code', () => {
  const docs = many(9, () => write('docs/12/plan.md', { lines: [1, 20] }));
  assert.deepEqual(A.drift(docs, []), []);
  const code = many(9, () => write('src/a.ts', { lines: [1, 20] }));
  assert.ok(kinds(A.drift(code, [])).includes('churn'));
});

test('long absolute paths from other repos are shortened for reading', () => {
  assert.equal(A.shortFile('src/app/a.ts'), 'src/app/a.ts');
  assert.equal(A.shortFile('/mnt/disk/acme/orders-service/src/Services/Thing.cs'), '…/src/Services/Thing.cs');
  assert.equal(A.shortFile('~/proj/b.ts'), '~/proj/b.ts');
  assert.equal(A.shortFile('/a/b'), '/a/b');
  assert.equal(A.shortFile(''), '');
  const d = A.drift(many(5, () => read('/mnt/disk/acme/orders-service/src/Services/Thing.cs')), []);
  assert.equal(d[0].title, 'Read …/src/Services/Thing.cs 5 times');
});
