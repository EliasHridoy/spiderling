const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assistant, text, toolUse, result } = require('./helpers.js');

// Point every agent's home at a temp folder before the watcher resolves it, so
// the tests never read the real ~/.claude, ~/.codex or ~/.gemini. The folder is
// under the home directory, not /tmp: Antigravity's source ignores /tmp paths.
const base = fs.mkdtempSync(path.join(os.homedir(), 'spiderling-watch-test-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
process.env.CODEX_HOME = path.join(base, 'codex');
process.env.SPIDERLING_ANTIGRAVITY_HOME = path.join(base, 'agy');
const { SessionWatcher } = require('../out/transcript/sessionWatcher.js');
const { projectDirFor } = require('../out/transcript/claudeSource.js');

const append = (file, recs) => fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
async function until(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('timed out waiting for the watcher');
}
const read = (id, file, extra = {}) => [
  assistant([toolUse(id, 'Read', { file_path: file })]),
  result(id, 'x', { type: 'text', file: { filePath: file, startLine: 1, numLines: 5, totalLines: 5 } }, extra),
];

test('tails main + subagent transcripts, flags backlog vs live, writes the trace file', async () => {
  const ws = path.join(base, 'ws');
  fs.mkdirSync(path.join(ws, 'docs', '2793'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', '2793', 'instructions.md'), '# story\n');
  const pd = projectDirFor(ws);
  fs.mkdirSync(pd, { recursive: true });
  const main = path.join(pd, 'sess-1.jsonl');

  // history from before the extension started
  const old = [{ type: 'ai-title', aiTitle: 'Issue 2793' }, ...read('t1', path.join(ws, 'docs/2793/instructions.md'))];
  fs.writeFileSync(main, old.map((r) => JSON.stringify({ ...r, timestamp: '2020-01-01T00:00:00.000Z' })).join('\n') + '\n');

  const got = [];
  const written = [];
  const errors = [];
  const w = new SessionWatcher({
    root: ws,
    lookbackMs: 3600e3,
    pollMs: 40,
    writeTraces: true,
    traceFallbackDir: path.join(ws, '.spiderling', 'traces'), issueDocs: true,
    onEvent: (e, live) => got.push({ ...e, live }),
    onTraceWritten: (f) => written.push(f),
    onError: (m) => errors.push(m),
  });
  try {
    await until(() => got.length === 1);
    assert.equal(got[0].live, false, 'history is replayed quietly');
    assert.ok(w.isTracked('sess-1'));

    // live: a search, then a read of one of its hits; a half-written line must wait
    const grep = [
      assistant([text('Find the mapping. My token: ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'), toolUse('t2', 'Bash', { command: `cd ${ws} && grep -rn "finish_to_start" src` })]),
      result('t2', '', { stdout: 'src/gantt.ts:130:finish_to_start\n' }),
    ];
    append(main, grep.slice(0, 1));
    const half = JSON.stringify(grep[1]);
    fs.appendFileSync(main, half.slice(0, 20));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got.length, 1, 'an incomplete line is held back');
    fs.appendFileSync(main, half.slice(20) + '\n');
    append(main, read('t3', path.join(ws, 'src/gantt.ts')));
    await until(() => got.length === 3);
    assert.deepEqual(got.slice(1).map((e) => [e.op, e.live]), [['search', true], ['read', true]]);
    assert.equal(got[1].hitCount, 1);

    // a subagent, with its meta file arriving just after the transcript
    const sd = path.join(pd, 'sess-1', 'subagents');
    fs.mkdirSync(sd, { recursive: true });
    append(path.join(sd, 'agent-abc.jsonl'), [
      assistant([toolUse('s1', 'Write', { file_path: path.join(ws, 'docs/2793/plan.md'), content: '# plan' })]),
      result('s1', 'ok', { type: 'create', filePath: path.join(ws, 'docs/2793/plan.md') }),
    ]);
    fs.writeFileSync(path.join(sd, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'planner-fe', description: 'Plan #2793' }));
    await until(() => got.length === 4);
    assert.equal(got[3].agent, 'planner-fe');
    assert.equal(got[3].agentId, 'abc');
    assert.equal(got[3].live, true);

    // a malformed record in the middle never stops the tail
    fs.appendFileSync(main, '{"type":"assistant","message":{"content":[{"type":"tool_use"\n');
    append(main, read('t4', path.join(ws, 'src/other.ts')));
    await until(() => got.length === 5);
    assert.equal(errors.length, 0);
  } finally {
    w.dispose(); // flushes the trace
  }

  const traceFile = path.join(ws, 'docs', '2793', 'agent-trace.json');
  assert.ok(written.includes(traceFile));
  const doc = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
  const s = doc.sessions['sess-1'];
  assert.equal(doc.issue, '2793');
  assert.equal(s.title, 'Issue 2793');
  assert.deepEqual(s.agents.map((a) => a.key).sort(), ['main', 'planner-fe:abc']);
  assert.equal(s.agents.find((a) => a.key === 'planner-fe:abc').description, 'Plan #2793');
  assert.equal(s.steps.length, 5);
  assert.ok(!JSON.stringify(doc).includes('ghp_' + 'abcdef'), 'secrets never reach the shared file');
  assert.equal(s.redactions, 1);
  assert.ok(Object.keys(s.metrics.tokens).length > 0);
});

test('follows Claude sessions started in another worktree of the same repository, and ignores other projects', async () => {
  const repo = path.join(base, 'wt', 'app');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'KAN-1'), { recursive: true });
  const wtree = path.join(base, 'wt', 'app-wt', 'KAN-1');
  fs.mkdirSync(wtree, { recursive: true });
  fs.writeFileSync(path.join(wtree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'KAN-1')}\n`);
  const other = path.join(base, 'wt', 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  const logOf = (dir, name, cwd) => {
    const f = path.join(projectDirFor(dir), `${name}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ type: 'mode', mode: 'normal' }) + '\n');
    append(f, read('t1', path.join(cwd, 'a.ts'), { cwd }));
    return f;
  };
  const sibling = logOf(wtree, 'sess-wt', wtree);
  logOf(other, 'sess-other', other);
  const got = [];
  const w = new SessionWatcher({ root: repo, lookbackMs: 3600e3, pollMs: 40, writeTraces: false, sources: ['claude'], onEvent: (e) => got.push(e) });
  try {
    await until(() => got.length >= 1);
    assert.ok(w.isTracked('sess-wt'));
    assert.equal(w.isTracked('sess-other'), false);
    assert.equal(got[0].agent, 'main');
    append(sibling, read('t2', path.join(wtree, 'b.ts'), { cwd: wtree }));
    await until(() => got.length >= 2); // and it keeps following the log
  } finally {
    w.dispose();
  }
});

test('old sessions outside the lookback window are not replayed', async () => {
  const ws = path.join(base, 'ws3');
  fs.mkdirSync(ws, { recursive: true });
  const pd = projectDirFor(ws);
  fs.mkdirSync(pd, { recursive: true });
  const file = path.join(pd, 'ancient.jsonl');
  append(file, read('t1', path.join(ws, 'a.ts')));
  const longAgo = new Date(Date.now() - 3 * 3600e3);
  fs.utimesSync(file, longAgo, longAgo);
  const got = [];
  const w = new SessionWatcher({ root: ws, lookbackMs: 3600e3, pollMs: 40, writeTraces: false, onEvent: (e) => got.push(e) });
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got.length, 0);
    assert.equal(w.isTracked('ancient'), false);
  } finally {
    w.dispose();
  }
});

const pad = (n) => String(n).padStart(2, '0');
function codexRollout(id, cwd, records) {
  const d = new Date();
  const f = path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()), `rollout-x-${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [{ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id, cwd, git: { branch: 'feat/cx' } } }, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const cxCall = (id, cmd, cwd) => ({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd, workdir: cwd }) } });
const cxOut = (id, body) => ({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: `Process exited with code 0\nOutput:\n${body}` } });
function agyConversation(id, records) {
  const f = path.join(process.env.SPIDERLING_ANTIGRAVITY_HOME, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const agyStep = (i, calls) => ({ step_index: i, type: 'PLANNER_RESPONSE', created_at: new Date().toISOString(), input_tokens: 10, output_tokens: 2, tool_calls: calls });

test('follows Codex and Antigravity sessions alongside Claude\'s, each labelled and traced', async () => {
  const ws = path.join(base, 'multi');
  fs.mkdirSync(path.join(ws, 'docs', '7'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', '7', 'plan.md'), '# plan\n');
  fs.writeFileSync(path.join(ws, 'a.ts'), 'x\n');
  const cx = codexRollout('cx-1', ws, []);
  const agy = agyConversation('agy-1', [agyStep(0, [{ name: 'run_command', args: { CommandLine: 'ls', Cwd: ws } }])]);
  const got = [];
  const w = new SessionWatcher({
    root: ws, lookbackMs: 3600e3, pollMs: 40, writeTraces: true, traceFallbackDir: path.join(ws, '.spiderling', 'traces'), issueDocs: true,
    onEvent: (e, live) => got.push({ ...e, live }),
  });
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(w.isTracked('cx-1'));
    append(cx, [cxCall('c1', "sed -n '1,5p' docs/7/plan.md", ws), cxOut('c1', 'text')]);
    append(agy, [agyStep(1, [{ name: 'view_file', args: { AbsolutePath: path.join(ws, 'a.ts'), StartLine: 1, EndLine: 3, toolSummary: 'Read a.ts' } }, { name: 'list_dir', args: { DirectoryPath: ws } }])]);
    await until(() => got.some((e) => e.agent === 'codex') && got.some((e) => e.agent === 'antigravity' && e.op === 'read'));
    const codex = got.find((e) => e.agent === 'codex');
    const read = got.find((e) => e.agent === 'antigravity' && e.op === 'read');
    assert.deepEqual([codex.op, codex.file, codex.startLine, codex.endLine, codex.live], ['read', 'docs/7/plan.md', 1, 5, true]);
    assert.deepEqual([read.file, read.startLine, read.endLine, read.caption, read.live], ['a.ts', 1, 3, 'Read a.ts', true]);
  } finally {
    w.dispose();
  }
  const doc = JSON.parse(fs.readFileSync(path.join(ws, 'docs', '7', 'agent-trace.json'), 'utf8'));
  assert.equal(doc.sessions['cx-1'].source, 'codex');
  assert.equal(doc.sessions['cx-1'].branch, 'feat/cx');
  assert.equal(doc.sessions['cx-1'].agents[0].key, 'codex');
});

test('spiderling.agentSources limits which agents are read', async () => {
  const ws = path.join(base, 'only-claude');
  fs.mkdirSync(ws, { recursive: true });
  codexRollout('cx-2', ws, [cxCall('c1', 'cat a.ts', ws), cxOut('c1', 'x')]);
  const got = [];
  const w = new SessionWatcher({ root: ws, lookbackMs: 3600e3, pollMs: 40, writeTraces: false, sources: ['claude'], onEvent: (e) => got.push(e) });
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got.length, 0);
    assert.equal(w.isTracked('cx-2'), false);
  } finally {
    w.dispose();
  }
  const got2 = [];
  const w2 = new SessionWatcher({ root: ws, lookbackMs: 3600e3, pollMs: 40, writeTraces: false, sources: ['codex'], onEvent: (e) => got2.push(e) });
  try {
    await until(() => got2.length > 0);
    assert.equal(got2[0].agent, 'codex');
  } finally {
    w2.dispose();
  }
});

test('live edits get the function name from the repo\'s CodeGraph index; history and opted-out runs do not', async () => {
  const ws = path.join(base, 'symrepo');
  fs.mkdirSync(path.join(ws, 'docs', '9'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.codegraph'), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(ws, '.codegraph', 'codegraph.db'));
  db.exec('CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER)');
  db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)').run('1', 'function', 'doThing', 'doThing', 'src/a.ts', 1, 50);
  db.close();

  const pd = projectDirFor(ws);
  fs.mkdirSync(pd, { recursive: true });
  const main = path.join(pd, 'sym-1.jsonl');
  const edit = (id, file, line, ts) => [
    { ...assistant([toolUse(id, 'Edit', { file_path: file })]), timestamp: ts },
    { ...result(id, 'ok', { filePath: file, structuredPatch: [{ oldStart: line, oldLines: 1, newStart: line, newLines: 1, lines: ['-a', '+b'] }] }), timestamp: ts },
  ];
  // history: an old edit that must not be named from today's index
  append(main, edit('h1', path.join(ws, 'src/a.ts'), 5, '2020-01-01T00:00:00.000Z'));

  const run = async (symbols) => {
    const got = [];
    const w = new SessionWatcher({
      root: ws, lookbackMs: 3600e3, pollMs: 40, writeTraces: true, symbols, sources: ['claude'],
      traceFallbackDir: path.join(ws, '.spiderling', 'traces'), issueDocs: true, onEvent: (e) => got.push(e),
    });
    try {
      await until(() => got.length >= 1);
      append(main, [
        ...edit(`l${symbols}`, path.join(ws, 'src/a.ts'), 12, new Date().toISOString()),
        ...edit(`p${symbols}`, path.join(ws, 'docs/9/plan.md'), 1, new Date().toISOString()),
      ]);
      await until(() => got.length >= 3);
    } finally {
      w.dispose(); // forces pending symbol lookups, then writes the trace
    }
    return JSON.parse(fs.readFileSync(path.join(ws, 'docs', '9', 'agent-trace.json'), 'utf8')).sessions['sym-1'].steps;
  };

  const on = await run(true);
  const live = on.filter((s) => s.file === 'src/a.ts' && s.lines[0] === 12);
  assert.equal(live.length, 1);
  assert.equal(live[0].symbol, 'doThing');
  assert.equal(on.find((s) => s.file === 'src/a.ts' && s.lines[0] === 5).symbol, undefined, 'history is not named');
  assert.equal(on.find((s) => s.file === 'docs/9/plan.md').symbol, undefined, 'no node covers a plan file');

  // a restart rebuilds the session from the log; the names found live are kept
  const again = await run(false);
  assert.equal(again.find((s) => s.file === 'src/a.ts' && s.lines[0] === 12).symbol, 'doThing');
});
