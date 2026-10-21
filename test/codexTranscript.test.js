const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { CodexTranscriptParser, execCommands, patchFiles } = require('../out/transcript/codexTranscript.js');

const ROOT = '/ws';
let n = 0;
const at = () => new Date(Date.now() + n++).toISOString();
const rec = (type, payload) => ({ timestamp: at(), type, payload });
const meta = (cwd = ROOT, branch = 'feat/x') => rec('session_meta', { id: 'sid', cwd, git: { branch } });
const turn = (model = 'gpt-5.6-terra') => rec('turn_context', { model, cwd: ROOT });
const call = (id, cmd, workdir) => rec('response_item', { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd, workdir }) });
const out = (id, body, code = 0) => rec('response_item', { type: 'function_call_output', call_id: id, output: `Chunk ID: a1\nWall time: 0.0000 seconds\nProcess exited with code ${code}\nOriginal token count: 5\nOutput:\n${body}` });
const say = (text) => rec('event_msg', { type: 'agent_message', message: text, phase: 'commentary' });

function run(records) {
  const p = new CodexTranscriptParser(ROOT, 'sid');
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

test('session_meta gives the working directory and branch once', () => {
  const { metas } = run([meta(), meta()]);
  assert.deepEqual(metas, [{ kind: 'context', cwd: '/ws', gitBranch: 'feat/x' }]);
});

test('exec_command: sed -n becomes a read with its range, resolved against workdir', () => {
  const { events } = run([meta(), call('c1', "sed -n '10,40p' src/a.ts", '/ws/pkg'), out('c1', 'text')]);
  assert.deepEqual(events.map(brief), [['read', 'sed', 'pkg/src/a.ts', 10, 40]]);
  assert.equal(events[0].agent, 'codex');
  assert.equal(events[0].session, 'sid');
});

test('exec_command: rg becomes a search with hits taken from the output', () => {
  const { events } = run([meta(), call('c1', 'rg -n finish_to_start src', '/ws'), out('c1', 'src/g.ts:130:  finish_to_start: "0",\nsrc/g.ts:140:  finish_to_start\n')]);
  const e = events[0];
  assert.equal(e.op, 'search');
  assert.equal(e.tool, 'rg');
  assert.equal(e.hitCount, 2);
  assert.deepEqual(e.hits.map((h) => [h.file, h.line]), [['src/g.ts', 130], ['src/g.ts', 140]]);
});

test('exec_command: a failed command keeps searches but not reads', () => {
  const { events } = run([meta(), call('c1', 'cat src/a.ts', '/ws'), out('c1', 'cat: no such file', 1)]);
  assert.equal(events.filter((e) => e.op === 'read').length, 0);
});

test('exec_command: other commands are recorded as a command', () => {
  const { events } = run([meta(), call('c1', 'dotnet build', '/ws'), out('c1', 'Build succeeded')]);
  assert.deepEqual([events[0].op, events[0].detail], ['bash', '$ dotnet build']);
});

test('the exec tool: commands are pulled out of the JS wrapper', () => {
  const js = `const a = await tools.exec_command({cmd:"sed -n '1,40p' src/a.ts", workdir:"/ws"});\nconst b = await tools.exec_command({cmd: 'cat b.ts'});\ntext(a.output)`;
  assert.deepEqual(execCommands(js), [{ cmd: "sed -n '1,40p' src/a.ts", workdir: '/ws' }, { cmd: 'cat b.ts', workdir: undefined }]);
  assert.deepEqual(execCommands('const x = await tools.exec_command({cmd: `echo ${name}`})'), []);
  assert.deepEqual(execCommands('nothing to see'), []);
  const { events } = run([
    meta(),
    rec('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'e1', input: js }),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'e1', output: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nok' }),
  ]);
  assert.deepEqual(events.map(brief), [['read', 'sed', 'src/a.ts', 1, 40], ['read', 'cat', 'b.ts', undefined, undefined]]);
});

test('patchFiles reads the apply_patch envelope', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: docs/n.md\n+hi\n*** Delete File: old.txt\n*** End Patch';
  assert.deepEqual(patchFiles(patch), ['src/a.ts', 'docs/n.md', 'old.txt']);
});

const patchCall = (id, body = '*** Update File: src/a.ts') => rec('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: id, input: `*** Begin Patch\n${body}\n*** End Patch` });
const patchEnd = (id, changes, success = true) => rec('event_msg', { type: 'patch_apply_end', call_id: id, success, changes });
const patchOut = (id, text = 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM src/a.ts\n') => rec('response_item', { type: 'custom_tool_call_output', call_id: id, output: text });

test('apply_patch: exact lines come from the patch_apply_end diff, and the output adds nothing', () => {
  const diff = '@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n@@ -20,3 +20,5 @@\n x\n+y\n+z\n w\n';
  const { events } = run([meta(), patchCall('p1'), patchEnd('p1', { '/ws/src/a.ts': { type: 'update', unified_diff: diff, move_path: null } }), patchOut('p1')]);
  assert.equal(events.length, 1);
  assert.deepEqual(brief(events[0]), ['write', 'apply_patch', 'src/a.ts', 2, 22]);
  assert.equal(events[0].lines, 3);
  assert.match(events[0].detail, /patched 3 line\(s\) @ line 2/);
});

test('apply_patch: added and deleted files', () => {
  const { events } = run([
    meta(),
    patchCall('p1', '*** Add File: docs/n.md\n*** Delete File: old.txt'),
    patchEnd('p1', { '/ws/docs/n.md': { type: 'add', content: 'a\nb\nc' }, '/ws/old.txt': { type: 'delete', content: 'bye' } }),
    patchOut('p1'),
  ]);
  assert.deepEqual(events.map((e) => [e.file, e.startLine, e.endLine, e.detail]), [
    ['docs/n.md', 1, 3, 'created (3 lines)'],
    ['old.txt', undefined, undefined, 'deleted'],
  ]);
});

test('apply_patch: a failed patch records nothing; a log without patch_apply_end falls back to the envelope', () => {
  assert.equal(run([meta(), patchCall('p1'), patchEnd('p1', {}, false), patchOut('p1', 'Exit code: 1\nOutput:\nfailed')]).events.length, 0);
  const { events } = run([meta(), patchCall('p2'), patchOut('p2')]);
  assert.deepEqual(events.map((e) => [e.file, e.detail, e.startLine]), [['src/a.ts', 'patched', undefined]]);
});

test('captions: the agent\'s words before a call, used once', () => {
  const { events } = run([
    meta(),
    say('I will read the repository `README` first.'),
    call('c1', 'cat a.md', '/ws'), out('c1', '...'),
    call('c2', 'cat b.md', '/ws'), out('c2', '...'),
  ]);
  assert.equal(events[0].caption, 'I will read the repository README first.');
  assert.equal(events[1].caption, undefined);
});

test('assistant message items also supply captions', () => {
  const { events } = run([
    meta(),
    rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the config.' }] }),
    call('c1', 'cat c.json', '/ws'), out('c1', '{}'),
  ]);
  assert.equal(events[0].caption, 'Checking the config.');
});

test('token usage: cached tokens are split out of input; the model comes from turn_context', () => {
  const { usage } = run([
    meta(), turn('gpt-5.6-terra'),
    rec('token_usage_record', { response_id: 'resp_1', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, cache_write_input_tokens: 0 } }),
  ]);
  assert.deepEqual(usage[0], { messageId: 'resp_1', model: 'gpt-5.6-terra', input: 400, output: 50, cacheRead: 600, cacheCreate: 0 });
});

test('codegraph_explore is a search', () => {
  const { events } = run([
    meta(),
    rec('response_item', { type: 'function_call', name: 'codegraph_explore', namespace: 'mcp__codegraph', call_id: 'g1', arguments: JSON.stringify({ projectPath: '/ws', query: 'how do links work' }) }),
    rec('response_item', { type: 'function_call_output', call_id: 'g1', output: 'ok' }),
  ]);
  assert.deepEqual([events[0].op, events[0].tool, events[0].query, events[0].hitCount], ['search', 'codegraph_explore', 'how do links work', undefined]);
});

test('scratch locations (Codex\'s own home, temp dirs) are left out', () => {
  const { events } = run([
    meta(),
    call('c1', `cat ${path.join(os.homedir(), '.codex', 'config.toml')}`, '/ws'), out('c1', 'x'),
    call('c2', 'cat /tmp/notes.txt', '/ws'), out('c2', 'x'),
  ]);
  assert.deepEqual(events.map((e) => e.op), ['bash', 'bash']);
});

test('unknown tools, malformed arguments and garbage are skipped without throwing', () => {
  const p = new CodexTranscriptParser(ROOT, 'sid');
  assert.equal(p.feed(null), null);
  assert.equal(p.feed('x'), null);
  for (const r of [
    rec('response_item', { type: 'function_call', name: 'update_plan', call_id: 'u', arguments: '{"plan":[]}' }),
    rec('response_item', { type: 'function_call', name: 'exec_command', call_id: 'bad', arguments: '{not json' }),
    rec('response_item', { type: 'function_call_output', call_id: 'unknown', output: 'x' }),
    rec('event_msg', { type: 'task_started' }),
    rec('world_state', { state: {} }),
    { type: 'response_item' },
    { timestamp: at(), type: 'event_msg', payload: 'not an object' },
  ]) {
    assert.deepEqual(p.feed(r).events, []);
  }
});

test('a shell command that exits non-zero is reported as a failed tool call', () => {
  const { metas } = run([meta(), call('c1', 'dotnet test', '/ws'), out('c1', 'Failed!', 1), call('c2', 'ls', '/ws'), out('c2', 'ok', 0)]);
  assert.deepEqual(metas.filter((m) => m.kind === 'toolError'), [{ kind: 'toolError', tool: 'shell' }]);
});
