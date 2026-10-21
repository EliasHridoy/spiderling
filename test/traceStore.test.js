const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionTrace, writeTrace, shareablePath, agentKey, carrySymbols } = require('../out/transcript/traceStore.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spiderling-trace-'));
const ev = (over = {}) => ({
  ts: '2026-10-18T07:00:00.000Z',
  op: 'read',
  file: 'src/a.ts',
  absFile: '/repo/src/a.ts',
  agent: 'main',
  agentId: '',
  tool: 'Read',
  session: 's1',
  toolUseId: 't',
  ...over,
});
const usage = (messageId, over = {}) => ({ messageId, model: 'claude-opus-5-5', input: 1, output: 2, cacheRead: 3, cacheCreate: 4, ...over });

test('shareablePath replaces the home directory and nothing else', () => {
  const home = os.homedir();
  assert.equal(shareablePath(`${home}/.claude/projects/x`), '~/.claude/projects/x');
  assert.equal(shareablePath(home), '~');
  assert.equal(shareablePath('/repo/src/a.ts'), '/repo/src/a.ts');
  assert.equal(shareablePath(`${home}-other/x`), `${home}-other/x`);
});

test('agentKey separates subagent instances of the same type', () => {
  assert.equal(agentKey('main', ''), 'main');
  assert.equal(agentKey('planner', 'abc'), 'planner:abc');
});

test('steps are recorded in the compact form and the home dir never leaks', () => {
  const home = os.homedir();
  const t = new SessionTrace('s1');
  t.addEvent(ev({ startLine: 10, endLine: 20, detail: 'read lines 10-20', caption: 'why' }));
  t.addEvent(ev({ op: 'search', file: 'src', query: 'foo', hitCount: 3, hits: [{ file: 'src/a.ts' }], tool: 'grep' }));
  t.addEvent(ev({ file: `${home}/.config/x.json`, absFile: `${home}/.config/x.json` }));
  const j = t.toJSON();
  assert.deepEqual(j.steps[0], { t: '2026-10-18T07:00:00.000Z', agent: 'main', op: 'read', file: 'src/a.ts', lines: [10, 20], detail: 'read lines 10-20', caption: 'why' });
  assert.deepEqual([j.steps[1].query, j.steps[1].hits], ['foo', 3]);
  assert.equal(j.steps[2].file, '~/.config/x.json');
  assert.ok(!JSON.stringify(j).includes(home));
  // a search keeps the paths it found, never the matched text or file contents
  assert.deepEqual(j.steps[1].hitFiles, ['src/a.ts']);
  assert.ok(!JSON.stringify(j.steps[1]).includes('text'));
});

test('credentials in captions, queries, details, titles and agent descriptions are masked and counted', () => {
  const t = new SessionTrace('s1');
  t.addEvent(ev({ caption: 'Use ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789 to push' }));
  t.addEvent(ev({ op: 'search', tool: 'grep', file: 'src', query: 'DB_PASSWORD=hunter22', hitCount: 0 }));
  t.addEvent(ev({ op: 'bash', file: '(bash)', detail: '$ curl -u admin:hunter22 https://x.test' }));
  t.addMeta({ kind: 'title', title: 'Fix login with token=abcd1234efgh' });
  t.describeAgent('planner', 'a1', 'Call https://bob:pw123456@host/api');
  const j = t.toJSON();
  const text = JSON.stringify(j);
  for (const leak of ['ghp_' + 'abcdef', 'hunter22', 'abcd1234efgh', 'pw123456']) {
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  }
  assert.equal(j.redactions, 5);
  assert.match(j.steps[0].caption, /Use \[redacted\] to push/);
});

test('redactions is 0 for a clean session', () => {
  const t = new SessionTrace('s1');
  t.addEvent(ev({ caption: 'Reading the story file first.' }));
  assert.equal(t.toJSON().redactions, 0);
});

test('usage is de-duplicated per message and grouped by model and agent', () => {
  const t = new SessionTrace('s1');
  t.addUsage('main', '', usage('m1'), '2026-10-18T07:00:00.000Z');
  t.addUsage('main', '', usage('m1', { output: 99 }), '2026-10-18T07:00:01.000Z'); // same response, later copy
  t.addUsage('main', '', usage('m2', { model: 'claude-haiku-5-5' }), '2026-10-18T07:00:02.000Z');
  t.addUsage('planner', 'a1', usage('m3'), '2026-10-18T07:00:03.000Z');
  const j = t.toJSON();
  assert.deepEqual(j.metrics.tokens['claude-opus-5-5'], { input: 2, output: 101, cacheRead: 6, cacheCreate: 8, messages: 2 });
  assert.equal(j.metrics.tokens['claude-haiku-5-5'].messages, 1);
  const planner = j.agents.find((a) => a.key === 'planner:a1');
  assert.equal(planner.tokens['claude-opus-5-5'].messages, 1);
});

test('PR, cost, branch and agents (sorted by first activity) come through', () => {
  const t = new SessionTrace('s1');
  t.addMeta({ kind: 'context', cwd: '/repo', gitBranch: 'feat/x' });
  t.addMeta({ kind: 'context', cwd: '/other', gitBranch: 'later' }); // first one wins
  t.addMeta({ kind: 'pr', number: 7, url: 'https://x/pr/7', repository: 'o/r' });
  t.addMeta({ kind: 'cost', costUSD: 2.5, durationMs: 60000, linesAdded: 10, linesRemoved: 2 });
  t.addEvent(ev({ ts: '2026-10-18T07:05:00.000Z', agent: 'planner', agentId: 'b' }));
  t.addEvent(ev({ ts: '2026-10-18T07:00:00.000Z' }));
  t.addMeta({ kind: 'spawn', spawn: { toolUseId: 't', agentType: 'planner', description: 'Plan it', agentId: 'b' } });
  const j = t.toJSON();
  assert.equal(j.branch, 'feat/x');
  assert.deepEqual(j.pr, { number: 7, url: 'https://x/pr/7', repository: 'o/r' });
  assert.equal(j.metrics.costUSD, 2.5);
  assert.equal(j.metrics.durationMs, 60000);
  assert.deepEqual(j.agents.map((a) => a.key), ['main', 'planner:b']);
  assert.equal(j.agents[1].description, 'Plan it');
  assert.equal(j.startedAt, '2026-10-18T07:00:00.000Z');
  assert.equal(j.endedAt, '2026-10-18T07:05:00.000Z');
  assert.deepEqual(j.steps.map((s) => s.t), ['2026-10-18T07:00:00.000Z', '2026-10-18T07:05:00.000Z']);
});

test('docsDir picks the issue folder the session worked in, weighting instructions/plan files', () => {
  const t = new SessionTrace('s1');
  for (let i = 0; i < 3; i++) t.addEvent(ev({ absFile: '/repo/docs/9/notes.txt' }));
  t.addEvent(ev({ absFile: '/repo/docs/2793/plan.md' }));
  assert.equal(t.docsDir(), path.join('/repo', 'docs', '2793'));
  assert.equal(new SessionTrace('empty').docsDir(), undefined);
  const noDocs = new SessionTrace('x');
  noDocs.addEvent(ev({ absFile: '/repo/src/docs/readme.md' }));
  assert.equal(noDocs.docsDir(), undefined);
});

function traceFor(repo, issue, session, ts) {
  const t = new SessionTrace(session);
  t.addEvent(ev({ ts, absFile: path.join(repo, 'docs', issue, 'plan.md'), file: `docs/${issue}/plan.md` }));
  return t;
}

test('writeTrace puts the file next to the issue docs and merges sessions', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'docs', '2793'), { recursive: true });
  const seen = new Map();
  const first = writeTrace(traceFor(repo, '2793', 'sA', '2026-10-18T07:00:00.000Z'), undefined, seen, true);
  assert.equal(first, path.join(repo, 'docs', '2793', 'agent-trace.json'));
  const second = writeTrace(traceFor(repo, '2793', 'sB', '2026-10-17T07:00:00.000Z'), undefined, seen, true);
  assert.equal(second, first);
  const doc = JSON.parse(fs.readFileSync(first, 'utf8'));
  assert.equal(doc.schema, 'spiderling.agent-trace/v1');
  assert.equal(doc.issue, '2793');
  assert.deepEqual(Object.keys(doc.sessions), ['sB', 'sA']); // oldest first
  assert.deepEqual(fs.readdirSync(path.join(repo, 'docs', '2793')), ['agent-trace.json']); // no temp file left
});

test('writeTrace keeps sessions already in the file and replaces a session when it grows', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'docs', '1'), { recursive: true });
  const file = path.join(repo, 'docs', '1', 'agent-trace.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'amlog.agent-trace/v1', issue: '1', sessions: { old: { startedAt: '2020-01-01T00:00:00.000Z', steps: [] } } }));
  const t = traceFor(repo, '1', 'live', '2026-10-18T07:00:00.000Z');
  writeTrace(t, undefined, new Map(), true);
  t.addEvent(ev({ ts: '2026-10-18T07:01:00.000Z', absFile: path.join(repo, 'docs/1/plan.md'), file: 'docs/1/plan.md' }));
  writeTrace(t, undefined, new Map(), true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(doc.sessions), ['old', 'live']);
  assert.equal(doc.sessions.live.steps.length, 2);
});

test('writeTrace does not rewrite an unchanged trace', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'docs', '5'), { recursive: true });
  const seen = new Map();
  const t = traceFor(repo, '5', 's', '2026-10-18T07:00:00.000Z');
  assert.ok(writeTrace(t, undefined, seen, true));
  const before = fs.statSync(path.join(repo, 'docs/5/agent-trace.json')).mtimeMs;
  assert.equal(writeTrace(t, undefined, seen, true), undefined);
  assert.equal(fs.statSync(path.join(repo, 'docs/5/agent-trace.json')).mtimeMs, before);
});

test('writeTrace ignores an unreadable or foreign existing file instead of crashing', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'docs', '3'), { recursive: true });
  const file = path.join(repo, 'docs', '3', 'agent-trace.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(writeTrace(traceFor(repo, '3', 's', '2026-10-18T07:00:00.000Z'), undefined, new Map(), true), file);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).sessions), ['s']);
});

test('by default a session goes to its own file in the trace folder, and that folder ignores itself in git', () => {
  const root = tmp();
  const t = new SessionTrace('sess-9');
  t.addEvent(ev({ absFile: '/repo/src/a.ts' }));
  const dir = path.join(root, '.spiderling', 'traces'); // does not exist yet
  const file = writeTrace(t, dir, new Map());
  assert.equal(file, path.join(dir, 'sess-9.json'));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.issue, null);
  assert.equal(doc.schema, 'spiderling.agent-trace/v1');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '# mine\n');
  t.addEvent(ev({ absFile: '/repo/src/b.ts', ts: '2026-10-18T07:00:09.000Z' }));
  writeTrace(t, dir, new Map());
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '# mine\n', 'an existing .gitignore is left alone');
  assert.equal(writeTrace(t, undefined, new Map()), undefined, 'nowhere to write');
});

test('a session that worked in docs/<n>/ stays out of there unless asked', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'docs', '8'), { recursive: true });
  const dir = path.join(repo, '.traces');
  const t = traceFor(repo, '8', 's', '2026-10-18T07:00:00.000Z');
  assert.equal(writeTrace(t, dir, new Map()), path.join(dir, 's.json'));
  assert.ok(!fs.existsSync(path.join(repo, 'docs', '8', 'agent-trace.json')));
  assert.equal(writeTrace(t, dir, new Map(), true), path.join(repo, 'docs', '8', 'agent-trace.json'));
});

test('a file from an older build (amlog.agent-trace/v1) is still merged, and rewritten with the current id', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'docs', '6'), { recursive: true });
  const file = path.join(repo, 'docs', '6', 'agent-trace.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'amlog.agent-trace/v1', issue: '6', sessions: { older: { startedAt: '2020-01-01T00:00:00.000Z', steps: [] } } }));
  writeTrace(traceFor(repo, '6', 'newer', '2026-10-18T07:00:00.000Z'), undefined, new Map(), true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.schema, 'spiderling.agent-trace/v1');
  assert.deepEqual(Object.keys(doc.sessions), ['older', 'newer']);
});
