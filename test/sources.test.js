const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate every agent's home before the sources resolve it. The fixtures live
// under the home directory, not /tmp: Antigravity's source (rightly) ignores
// /tmp paths when working out which workspace a conversation belongs to.
const base = fs.mkdtempSync(path.join(os.homedir(), 'spiderling-src-test-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
process.env.CODEX_HOME = path.join(base, 'codex');
process.env.SPIDERLING_ANTIGRAVITY_HOME = path.join(base, 'agy');
process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
const { repoIdentity, belongsToWorkspace, headRecords } = require('../out/transcript/source.js');
const { CodexSource } = require('../out/transcript/codexSource.js');
const { AntigravitySource } = require('../out/transcript/antigravitySource.js');
const { ClaudeSource, projectDirFor } = require('../out/transcript/claudeSource.js');

const mk = (...p) => { const d = path.join(base, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const ctx = (root, over = {}) => ({ root, cutoffMs: Date.now() - 3600e3, now: Date.now(), hasTail: () => false, ...over });
const jsonl = (file, recs) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

// ---- workspace matching ----------------------------------------------------------------

test('repoIdentity resolves a git worktree to its main repository', () => {
  const repo = mk('repos', 'app');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'KAN-1'), { recursive: true });
  const wt = mk('repos', 'app-wt', 'KAN-1');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'KAN-1')}\n`);
  const deep = mk('repos', 'app-wt', 'KAN-1', 'src', 'x');
  assert.equal(repoIdentity(repo), repo);
  assert.equal(repoIdentity(wt), repo);
  assert.equal(repoIdentity(deep), repo);
  assert.equal(repoIdentity(path.join(deep, 'not-yet-created.ts')), repo);
  assert.equal(repoIdentity(mk('plain', 'folder')), undefined);
});

test('belongsToWorkspace: inside the folder, in a sibling worktree, but not elsewhere', () => {
  const repo = mk('ws1', 'app');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'w'), { recursive: true });
  const wt = mk('ws1', 'app-wt', 'w');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'w')}\n`);
  const other = mk('ws1', 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  assert.ok(belongsToWorkspace(repo, path.join(repo, 'src', 'a.ts')));
  assert.ok(belongsToWorkspace(repo, repo));
  assert.ok(belongsToWorkspace(repo, path.join(wt, 'src', 'a.ts')));
  assert.ok(belongsToWorkspace(wt, path.join(repo, 'src')), 'a worktree is the same workspace as its main repo');
  assert.ok(!belongsToWorkspace(repo, path.join(other, 'a.ts')));
  assert.ok(!belongsToWorkspace(repo, '/tmp/x'));
  assert.ok(!belongsToWorkspace(repo, 'relative/path'));
  assert.ok(!belongsToWorkspace(repo, ''));
  const plain = mk('ws1', 'plain'); // no git: only direct containment counts
  assert.ok(belongsToWorkspace(plain, path.join(plain, 'a')));
  assert.ok(!belongsToWorkspace(plain, path.join(repo, 'a')));
});

test('headRecords reads only the start of a log and skips broken lines', () => {
  const f = path.join(mk('head'), 'x.jsonl');
  fs.writeFileSync(f, '{"a":1}\nnot json\n{"a":2}\n{"a":3}\n');
  assert.deepEqual(headRecords(f, 3), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(headRecords(path.join(base, 'missing.jsonl'), 5), []);
});

// ---- Codex ----------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const codexDir = (d = new Date()) => path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
const rollout = (name, cwd) => {
  const f = path.join(codexDir(), `rollout-2026-10-20T10-00-00-${name}.jsonl`);
  jsonl(f, [{ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: name, cwd } }]);
  return f;
};

test('CodexSource follows rollouts whose cwd is in the workspace (or a worktree), and only those', () => {
  const root = mk('cx', 'app');
  fs.mkdirSync(path.join(root, '.git', 'worktrees', 'w'), { recursive: true });
  const wt = mk('cx', 'app-wt', 'w');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', 'w')}\n`);
  const here = rollout('11111111-1111-1111-1111-111111111111', root);
  const sibling = rollout('22222222-2222-2222-2222-222222222222', wt);
  rollout('33333333-3333-3333-3333-333333333333', mk('cx', 'unrelated'));
  const src = new CodexSource(root);
  const found = src.scan(ctx(root));
  assert.deepEqual(found.map((t) => t.file).sort(), [here, sibling].sort());
  assert.ok(found.every((t) => t.agent === 'codex' && t.agentId === '' && t.parser));
  assert.equal(found.find((t) => t.file === here).session, '11111111-1111-1111-1111-111111111111');
  // a rejected rollout is not looked at again; a followed one is not returned twice
  assert.deepEqual(src.scan(ctx(root, { hasTail: (f) => f === here || f === sibling })), []);
});

test('CodexSource skips old rollouts and waits for one whose session_meta is not written yet', () => {
  const root = mk('cx2', 'app');
  const old = rollout('44444444-4444-4444-4444-444444444444', root);
  fs.utimesSync(old, new Date(Date.now() - 5 * 3600e3), new Date(Date.now() - 5 * 3600e3));
  const empty = path.join(codexDir(), 'rollout-2026-10-20T10-00-01-55555555-5555-5555-5555-555555555555.jsonl');
  fs.writeFileSync(empty, '');
  const src = new CodexSource(root);
  assert.deepEqual(src.scan(ctx(root)), []);
  jsonl(empty, [{ type: 'session_meta', payload: { id: 'late', cwd: root } }]);
  assert.deepEqual(src.scan(ctx(root)).map((t) => t.session), ['late']);
});

// ---- Antigravity ----------------------------------------------------------------------

const brain = (id, calls) => {
  const f = path.join(process.env.SPIDERLING_ANTIGRAVITY_HOME, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
  jsonl(f, calls.map((c, i) => ({ step_index: i, type: 'PLANNER_RESPONSE', created_at: new Date().toISOString(), tool_calls: [c] })));
  return f;
};

test('AntigravitySource follows conversations whose first files are in the workspace', () => {
  const root = mk('ag', 'app');
  const mine = brain('aaaa', [{ name: 'view_file', args: { AbsolutePath: path.join(root, 'src', 'a.ts') } }]);
  brain('bbbb', [{ name: 'view_file', args: { AbsolutePath: path.join(mk('ag', 'else'), 'a.ts') } }]);
  const viaCwd = brain('cccc', [{ name: 'run_command', args: { CommandLine: 'ls', Cwd: root } }]);
  const src = new AntigravitySource(root);
  const found = src.scan(ctx(root));
  assert.deepEqual(found.map((t) => t.file).sort(), [mine, viaCwd].sort());
  assert.deepEqual(found.map((t) => [t.agent, t.agentId]).sort(), [['antigravity', ''], ['antigravity', '']]);
  assert.deepEqual(found.map((t) => t.session).sort(), ['aaaa', 'cccc']);
});

test('AntigravitySource ignores the agent\'s own hidden folders and temp files when deciding', () => {
  const root = mk('ag2', 'app');
  const home = os.homedir();
  brain('dddd', [
    { name: 'view_file', args: { AbsolutePath: path.join(home, '.gemini', 'skills', 'x', 'SKILL.md') } },
    { name: 'view_file', args: { AbsolutePath: '/tmp/scratch/a.txt' } },
    { name: 'view_file', args: { AbsolutePath: path.join(root, 'src', 'a.ts') } },
  ]);
  assert.deepEqual(new AntigravitySource(root).scan(ctx(root)).map((t) => t.session), ['dddd']);
});

test('AntigravitySource decides later when a conversation has touched no file yet', () => {
  const root = mk('ag3', 'app');
  const f = brain('eeee', [{ name: 'manage_task', args: { Action: 'status' } }]);
  const src = new AntigravitySource(root);
  assert.deepEqual(src.scan(ctx(root)), []);
  assert.deepEqual(src.scan(ctx(root)), [], 'not re-read while it has not grown');
  fs.appendFileSync(f, JSON.stringify({ step_index: 9, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'view_file', args: { AbsolutePath: path.join(root, 'a.ts') } }] }) + '\n');
  assert.deepEqual(src.scan(ctx(root)).map((t) => t.session), ['eeee']);
});

// ---- Claude ---------------------------------------------------------------------------

test('ClaudeSource finds main sessions and their subagents', () => {
  const root = mk('cl', 'app');
  const pd = projectDirFor(root);
  jsonl(path.join(pd, 'sess-1.jsonl'), [{ type: 'user' }]);
  const sd = path.join(pd, 'sess-1', 'subagents');
  jsonl(path.join(sd, 'agent-abc.jsonl'), [{ type: 'user' }]);
  fs.writeFileSync(path.join(sd, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'planner-fe', description: 'Plan it' }));
  const src = new ClaudeSource(root);
  const found = src.scan(ctx(root));
  assert.deepEqual(found.map((t) => [t.agent, t.agentId, t.session]).sort(), [['main', '', 'sess-1'], ['planner-fe', 'abc', 'sess-1']].sort());
  assert.equal(found.find((t) => t.agentId === 'abc').description, 'Plan it');
  // a second scan does not hand out the main log again
  assert.deepEqual(src.scan(ctx(root, { hasTail: (f) => found.some((t) => t.file === f) })), []);
});

test('ClaudeSource finds sessions run from another worktree of the repo by the cwd they record, and skips other projects', () => {
  const repo = mk('clw', 'app');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'w'), { recursive: true });
  const wt = mk('clw', 'app-wt', 'w');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'w')}\n`);
  const other = mk('clw', 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  const rec = (cwd) => [{ type: 'mode' }, { type: 'user', cwd }];
  const mine = path.join(projectDirFor(wt), 'sess-wt.jsonl');
  jsonl(mine, rec(wt));
  jsonl(path.join(projectDirFor(other), 'sess-other.jsonl'), rec(other));
  const noCwdYet = path.join(projectDirFor(wt), 'sess-new.jsonl');
  jsonl(noCwdYet, [{ type: 'mode' }]);
  const old = path.join(projectDirFor(wt), 'sess-old.jsonl');
  jsonl(old, rec(wt));
  fs.utimesSync(old, new Date(Date.now() - 9 * 3600e3), new Date(Date.now() - 9 * 3600e3));

  const src = new ClaudeSource(repo);
  const tracked = new Set();
  const first = src.scan(ctx(repo, { hasTail: (f) => tracked.has(f) }));
  assert.deepEqual(first.map((t) => t.file), [mine]);
  first.forEach((t) => tracked.add(t.file));

  // the log that had no cwd yet is picked up once it says where it runs
  fs.appendFileSync(noCwdYet, JSON.stringify({ type: 'user', cwd: wt }) + '\n');
  assert.deepEqual(src.scan(ctx(repo, { hasTail: (f) => tracked.has(f), now: Date.now() + 10000 })).map((t) => t.session), ['sess-new']);
});

test('subagents of a worktree session are followed too', () => {
  const repo = mk('clw2', 'app');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'w'), { recursive: true });
  const wt = mk('clw2', 'app-wt', 'w');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'w')}\n`);
  jsonl(path.join(projectDirFor(wt), 'sess-w.jsonl'), [{ type: 'user', cwd: wt }]);
  const sd = path.join(projectDirFor(wt), 'sess-w', 'subagents');
  jsonl(path.join(sd, 'agent-s1.jsonl'), [{ type: 'user' }]);
  fs.writeFileSync(path.join(sd, 'agent-s1.meta.json'), JSON.stringify({ agentType: 'reviewer' }));
  const found = new ClaudeSource(repo).scan(ctx(repo));
  assert.deepEqual(found.map((t) => [t.agent, t.agentId]).sort(), [['main', ''], ['reviewer', 's1']].sort());
});

test('a subagent whose meta file has not landed yet is picked up once it has', () => {
  const root = mk('cl2', 'app');
  const pd = projectDirFor(root);
  jsonl(path.join(pd, 'sess-2.jsonl'), [{ type: 'user' }]);
  const sd = path.join(pd, 'sess-2', 'subagents');
  jsonl(path.join(sd, 'agent-new.jsonl'), [{ type: 'user' }]);
  const src = new ClaudeSource(root);
  const tracked = new Set();
  const first = src.scan(ctx(root, { hasTail: (f) => tracked.has(f) }));
  assert.deepEqual(first.map((t) => t.agent), ['main'], 'waits for the meta file');
  first.forEach((t) => tracked.add(t.file));
  fs.writeFileSync(path.join(sd, 'agent-new.meta.json'), JSON.stringify({ agentType: 'implementor-fe' }));
  assert.deepEqual(src.scan(ctx(root, { hasTail: (f) => tracked.has(f) })).map((t) => t.agent), ['implementor-fe']);
});
