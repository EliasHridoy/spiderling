const test = require('node:test');
const assert = require('node:assert/strict');
const { AntigravityTranscriptParser } = require('../out/transcript/antigravityTranscript.js');

const ROOT = '/ws';
let step = 0;
const when = () => new Date(Date.now() + step).toISOString();
const planner = (calls, extra = {}) => ({ step_index: step++, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: when(), input_tokens: 100, cache_read_tokens: 40, output_tokens: 10, tool_calls: calls, ...extra });
const generic = (content) => ({ step_index: step++, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: when(), content: `Created At: x\nCompleted At: y\n${content}` });
const tc = (name, args) => ({ name, args: { toolSummary: `summary of ${name}`, ...args } });

function run(records) {
  const p = new AntigravityTranscriptParser(ROOT, 'conv-1');
  const events = [], metas = [], usage = [];
  for (const r of records) {
    const o = p.feed(r);
    if (!o) continue;
    events.push(...o.events); metas.push(...o.meta);
    if (o.usage) usage.push(o.usage);
  }
  return { events, metas, usage };
}
const brief = (e) => [e.op, e.tool, e.file, e.startLine, e.endLine];

test('view_file with a range is a read of exactly those lines', () => {
  const { events } = run([planner([tc('view_file', { AbsolutePath: '/ws/src/a.ts', StartLine: 10, EndLine: 40 }), tc('view_file', { AbsolutePath: '/ws/src/b.ts' })])]);
  assert.deepEqual(events.map(brief), [['read', 'view_file', 'src/a.ts', 10, 40], ['read', 'view_file', 'src/b.ts', undefined, undefined]]);
  assert.equal(events[0].detail, 'read lines 10-40');
  assert.equal(events[1].detail, 'read whole file');
  assert.equal(events[0].agent, 'antigravity');
  assert.equal(events[0].session, 'conv-1');
});

test('a lone view_file waits for its result and takes the range it actually showed', () => {
  const p = new AntigravityTranscriptParser(ROOT, 'conv-1');
  assert.deepEqual(p.feed(planner([tc('view_file', { AbsolutePath: '/ws/src/a.ts' })])).events, []);
  const e = p.feed(generic('File Path: `file:///ws/src/a.ts`\nTotal Lines: 400\nShowing lines 1 to 200\n')).events;
  assert.deepEqual(e.map(brief), [['read', 'view_file', 'src/a.ts', 1, 200]]);
});

test('a waiting call that never gets a result is flushed by the next turn', () => {
  const p = new AntigravityTranscriptParser(ROOT, 'conv-1');
  p.feed(planner([tc('view_file', { AbsolutePath: '/ws/src/a.ts' })]));
  const next = p.feed(planner([tc('view_file', { AbsolutePath: '/ws/src/b.ts', StartLine: 1, EndLine: 5 }), tc('list_dir', { DirectoryPath: '/ws' })])).events;
  assert.deepEqual(next.map((e) => e.file), ['src/a.ts', 'src/b.ts', '.']);
});

test('edits: replace, multi-replace, write_to_file, edit_file', () => {
  const { events } = run([planner([
    tc('replace_file_content', { TargetFile: '/ws/a.ts', StartLine: 9, EndLine: 20, ReplacementContent: 'x\ny\nz' }),
    tc('multi_replace_file_content', { TargetFile: '/ws/b.ts', ReplacementChunks: [{ StartLine: 3, EndLine: 4, ReplacementContent: 'p\nq' }, { StartLine: 50, EndLine: 50, ReplacementContent: 'r' }] }),
    tc('write_to_file', { TargetFile: '/ws/c.md', CodeContent: 'one\ntwo', Overwrite: false }),
    tc('write_to_file', { TargetFile: '/ws/d.md', CodeContent: 'one', Overwrite: true }),
    tc('edit_file', { Path: '/ws/e.ts', Target: 'a', Replacement: 'b' }),
  ])]);
  assert.deepEqual(events.map((e) => [e.file, e.startLine, e.endLine, e.lines, e.detail]), [
    ['a.ts', 9, 11, 3, 'edited 3 line(s) @ line 9'],
    ['b.ts', 3, 50, 3, '2 edit(s), 3 line(s)'],
    ['c.md', 1, 2, 2, 'created (2 lines)'],
    ['d.md', 1, 1, 1, 'rewrote (1 lines)'],
    ['e.ts', undefined, undefined, undefined, 'edited'],
  ]);
  assert.ok(events.every((e) => e.op === 'write'));
});

test('run_command: sed/grep in the shell become reads and searches, with hits from the output', () => {
  const p = new AntigravityTranscriptParser(ROOT, 'conv-1');
  p.feed(planner([tc('run_command', { CommandLine: 'grep -rn finish_to_start src', Cwd: '/ws' })]));
  const e = p.feed(generic('\nThe command exited with code 0.\nOutput:\nsrc/g.ts:130:  finish_to_start\n')).events;
  assert.equal(e[0].op, 'search');
  assert.equal(e[0].hitCount, 1);
  assert.deepEqual(e[0].hits[0], { file: 'src/g.ts', line: 130, text: '  finish_to_start' });
});

test('run_command: a failed command drops its reads', () => {
  const p = new AntigravityTranscriptParser(ROOT, 'conv-1');
  p.feed(planner([tc('run_command', { CommandLine: 'cat src/a.ts', Cwd: '/ws' })]));
  const e = p.feed(generic('\nThe command exited with code 1.\nOutput:\ncat: no such file\n')).events;
  assert.equal(e.filter((x) => x.op === 'read').length, 0);
});

test('run_command in a batch is built from the command alone, with the tool summary as the description', () => {
  const { events } = run([planner([tc('run_command', { CommandLine: 'sed -n "5,9p" a.ts', Cwd: '/ws' }), tc('run_command', { CommandLine: 'npm run build', Cwd: '/ws', toolSummary: 'Build the app' })])]);
  assert.deepEqual(events.map((e) => [e.op, e.file, e.startLine, e.endLine, e.detail]), [
    ['read', 'a.ts', 5, 9, 'sed lines 5-9'],
    ['bash', '(bash)', undefined, undefined, '$ Build the app'],
  ]);
});

test('find_by_name: hits from the result, relative to the search directory', () => {
  const p = new AntigravityTranscriptParser(ROOT, 'conv-1');
  p.feed(planner([tc('find_by_name', { Pattern: '*member*', SearchDirectory: '/ws/src' })]));
  const found = p.feed(generic('Found 2 results\nfeatures/members/a.ts\nfeatures/members/b.ts')).events[0];
  assert.equal(found.hitCount, 2);
  assert.deepEqual(found.hits.map((h) => h.file), ['src/features/members/a.ts', 'src/features/members/b.ts']);
  p.feed(planner([tc('find_by_name', { Pattern: '*nope*', SearchDirectory: '/ws/src' })]));
  assert.equal(p.feed(generic('No results found')).events[0].hitCount, 0);
});

test('grep_search, list_dir and codegraph are searches without hit data', () => {
  const { events } = run([planner([
    tc('grep_search', { Query: 'trainer_assignments', SearchPath: '/ws' }),
    tc('list_dir', { DirectoryPath: '/ws/src' }),
    tc('call_mcp_tool', { ServerName: 'codegraph', ToolName: 'codegraph_explore', Arguments: { query: 'how links work' } }),
  ])]);
  assert.deepEqual(events.map((e) => [e.op, e.tool, e.query, e.hitCount]), [
    ['search', 'grep_search', 'trainer_assignments', undefined],
    ['search', 'list_dir', '', undefined],
    ['search', 'codegraph_explore', 'how links work', undefined],
  ]);
  assert.equal(events[0].detail, 'grep "trainer_assignments"'); // no "→ n hits": it is not known
});

test('captions: prose when the model wrote some, else the call\'s own summary', () => {
  const { events } = run([
    planner([tc('view_file', { AbsolutePath: '/ws/a.ts' }), tc('view_file', { AbsolutePath: '/ws/b.ts' })], { content: 'Let me look at **both** files.' }),
    planner([tc('replace_file_content', { TargetFile: '/ws/a.ts', StartLine: 1, EndLine: 1, ReplacementContent: 'x', toolSummary: 'Fix the import' })]),
  ]);
  assert.equal(events[0].caption, 'Let me look at both files.');
  assert.equal(events[2].caption, 'Fix the import');
});

test('usage comes from the planner turn', () => {
  const { usage } = run([planner([])]);
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].input, usage[0].output, usage[0].cacheRead, usage[0].model], [100, 10, 40, 'antigravity']);
  assert.match(usage[0].messageId, /^conv-1:\d+$/);
});

test('invoke_subagent announces the subagents', () => {
  const { metas } = run([planner([tc('invoke_subagent', { Subagents: [{ TypeName: 'github-manager', Role: 'GitHub Workflow Manager', Prompt: 'p' }] })])]);
  assert.deepEqual(metas.map((m) => [m.kind, m.spawn.agentType, m.spawn.description]), [['spawn', 'github-manager', 'GitHub Workflow Manager']]);
});

test('scratch paths and hidden agent folders are left out', () => {
  const { events } = run([planner([tc('view_file', { AbsolutePath: '/tmp/x.txt' }), tc('list_dir', { DirectoryPath: '/tmp' }), tc('write_to_file', { TargetFile: '/tmp/y', CodeContent: 'a' })])]);
  assert.equal(events.length, 0);
});

test('other step types, unknown tools and garbage are skipped without throwing', () => {
  const p = new AntigravityTranscriptParser(ROOT, 'conv-1');
  assert.equal(p.feed(null), null);
  assert.equal(p.feed([]), null);
  for (const r of [
    { step_index: 1, type: 'USER_INPUT', content: 'hi' },
    { step_index: 2, type: 'SYSTEM_MESSAGE', content: 'x' },
    { step_index: 3, type: 'ERROR_MESSAGE', error: 'API error' },
    { step_index: 4, type: 'CHECKPOINT', content: 'x' },
    planner([tc('manage_task', { Action: 'status' }), tc('schedule', { DurationSeconds: 1, Prompt: 'x' })]),
    planner([{ name: 'view_file' }, 'junk', null]),
    { step_index: 5, type: 'GENERIC', content: 'a result nobody waits for' },
    { type: 'PLANNER_RESPONSE', tool_calls: 'not a list' },
  ]) {
    assert.deepEqual(p.feed(r).events, []);
  }
});

test('a run_command that exits non-zero is reported as a failed tool call', () => {
  const p = new AntigravityTranscriptParser(ROOT, 'conv-1');
  p.feed(planner([tc('run_command', { CommandLine: 'npm test', Cwd: '/ws' })]));
  const out = p.feed(generic('\nThe command exited with code 2.\nOutput:\nfailed\n'));
  assert.deepEqual(out.meta.filter((m) => m.kind === 'toolError'), [{ kind: 'toolError', tool: 'shell' }]);
});
