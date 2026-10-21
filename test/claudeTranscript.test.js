const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeTranscriptParser, displayPath } = require('../out/transcript/claudeTranscript.js');
const { assistant, text, toolUse, result, run } = require('./helpers.js');

const ROOT = '/ws';
const parser = (agent = 'main', id = '') => new ClaudeTranscriptParser(ROOT, 'sess', agent, id);

test('Read: exact range from the tool result', () => {
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Read', { file_path: '/ws/src/a.ts', offset: 10, limit: 10 })]),
    result('t1', 'x', { type: 'text', file: { filePath: '/ws/src/a.ts', startLine: 10, numLines: 10, totalLines: 400 } }),
  ]);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.op, 'read');
  assert.equal(e.file, 'src/a.ts');
  assert.equal(e.absFile, '/ws/src/a.ts');
  assert.deepEqual([e.startLine, e.endLine, e.lines], [10, 19, 10]);
  assert.equal(e.detail, 'read lines 10-19');
  assert.equal(e.agent, 'main');
  assert.equal(e.session, 'sess');
  assert.equal(e.toolUseId, 't1');
});

test('Read of a whole small file says so', () => {
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Read', { file_path: '/ws/a.md' })]),
    result('t1', 'x', { type: 'text', file: { filePath: '/ws/a.md', startLine: 1, numLines: 12, totalLines: 12 } }),
  ]);
  assert.equal(events[0].detail, 'read whole file (12 lines)');
});

test('Read falls back to the call input when the record holds several results', () => {
  const rec = {
    type: 'user',
    timestamp: '2026-10-18T07:00:00.000Z',
    toolUseResult: { file: { filePath: '/ws/WRONG.ts', startLine: 1, numLines: 1 } },
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'x' },
        { type: 'tool_result', tool_use_id: 't2', content: 'y' },
      ],
    },
  };
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Read', { file_path: '/ws/a.ts', offset: 5, limit: 3 }), toolUse('t2', 'Read', { file_path: '/ws/b.ts' })]),
    rec,
  ]);
  assert.deepEqual(events.map((e) => e.file), ['a.ts', 'b.ts']);
  assert.deepEqual([events[0].startLine, events[0].endLine], [5, 7]);
  assert.equal(events[1].startLine, undefined);
});

test('failed tool calls produce no read/write events', () => {
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Read', { file_path: '/ws/missing.ts' }), toolUse('t2', 'Edit', { file_path: '/ws/a.ts' })]),
    result('t1', 'File does not exist', 'Error: nope', {}, true),
    result('t2', 'string not found', 'Error: nope', {}, true),
  ]);
  assert.equal(events.length, 0);
});

test('Edit: changed range from the structured patch', () => {
  const patch = [{ oldStart: 128, oldLines: 5, newStart: 128, newLines: 6, lines: [' a', ' b', '-c', '+C', '+D', ' e'] }];
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Edit', { file_path: '/ws/src/a.ts' })]),
    result('t1', 'ok', { filePath: '/ws/src/a.ts', structuredPatch: patch }),
  ]);
  const e = events[0];
  assert.equal(e.op, 'write');
  assert.deepEqual([e.startLine, e.endLine, e.lines], [130, 131, 2]);
  assert.equal(e.detail, 'edited 2 line(s) @ line 130');
});

test('Edit: a pure deletion still points at where the lines were', () => {
  const patch = [{ oldStart: 5, oldLines: 3, newStart: 5, newLines: 2, lines: [' a', '-b', ' c'] }];
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Edit', { file_path: '/ws/a.ts' })]),
    result('t1', 'ok', { filePath: '/ws/a.ts', structuredPatch: patch }),
  ]);
  assert.deepEqual([events[0].startLine, events[0].endLine, events[0].lines], [6, 6, 0]);
});

test('Edit: several hunks span first to last change', () => {
  const patch = [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['+x', ' y'] },
    { oldStart: 50, oldLines: 2, newStart: 50, newLines: 2, lines: [' p', '+q'] },
  ];
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Edit', { file_path: '/ws/a.ts' })]),
    result('t1', 'ok', { filePath: '/ws/a.ts', structuredPatch: patch }),
  ]);
  assert.deepEqual([events[0].startLine, events[0].endLine, events[0].lines], [1, 51, 2]);
});

test('Write: created and rewritten files', () => {
  const create = run(parser(), [
    assistant([toolUse('t1', 'Write', { file_path: '/ws/docs/1/plan.md', content: '# plan\na\nb' })]),
    result('t1', 'ok', { type: 'create', filePath: '/ws/docs/1/plan.md' }),
  ]).events[0];
  assert.deepEqual([create.startLine, create.endLine, create.detail], [1, 3, 'created (3 lines)']);
  const rewrite = run(parser(), [
    assistant([toolUse('t2', 'Write', { file_path: '/ws/a.md', content: 'one\ntwo' })]),
    result('t2', 'ok', { type: 'update', filePath: '/ws/a.md', structuredPatch: [] }),
  ]).events[0];
  assert.equal(rewrite.detail, 'rewrote (2 lines)');
});

test('Bash grep becomes a search with its hits', () => {
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Bash', { command: 'cd /ws && grep -rn "finish_to_start" src | head' })]),
    result('t1', '', { stdout: 'src/gantt.ts:130:  finish_to_start: "0",\nsrc/gantt.ts:131:  start_to_start: "1",\n' }),
  ]);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.op, 'search');
  assert.equal(e.tool, 'grep');
  assert.equal(e.file, 'src');
  assert.equal(e.query, 'finish_to_start');
  assert.equal(e.hitCount, 2);
  assert.deepEqual(e.hits[0], { file: 'src/gantt.ts', line: 130, text: '  finish_to_start: "0",' });
  assert.match(e.detail, /→ 2 hit\(s\) in 1 file\(s\)/);
});

test('Bash search with no output records "no hits"', () => {
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Bash', { command: 'grep -rn nothing /ws/src' })]),
    result('t1', '', { stdout: '' }),
  ]);
  assert.equal(events[0].hitCount, 0);
  assert.match(events[0].detail, /no hits/);
});

test('Bash sed/cat/head become reads, redirects become writes, in command order', () => {
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Bash', { command: "sed -n '120,150p' src/a.ts && cat src/b.ts > /ws/out.txt" })]),
    result('t1', '', { stdout: '...' }),
  ]);
  assert.deepEqual(events.map((e) => [e.op, e.tool, e.file, e.startLine, e.endLine]), [
    ['read', 'sed', 'src/a.ts', 120, 150],
    ['read', 'cat', 'src/b.ts', undefined, undefined],
    ['write', 'redirect', 'out.txt', undefined, undefined],
  ]);
});

test('a failed Bash command keeps its searches but drops reads and writes', () => {
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Bash', { command: 'cat src/a.ts' })]),
    result('t1', 'cat: src/a.ts: No such file', { stdout: '' }, {}, true),
  ]);
  assert.equal(events.filter((e) => e.op === 'read').length, 0);
});

test('other Bash commands are recorded as a command with their description', () => {
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Bash', { command: 'npm test -- --watch=false', description: 'Run the unit tests' })]),
    result('t1', 'ok', { stdout: 'ok' }),
  ]);
  assert.equal(events[0].op, 'bash');
  assert.equal(events[0].detail, '$ Run the unit tests');
});

test('Grep and Glob tools: hits from filenames or content output', () => {
  const glob = run(parser(), [
    assistant([toolUse('t1', 'Glob', { pattern: '**/*.ts', path: '/ws/src' })]),
    result('t1', 'ignored', { filenames: ['/ws/src/a.ts', '/ws/src/b.ts'], numFiles: 2 }),
  ]).events[0];
  assert.deepEqual(glob.hits.map((h) => h.file), ['src/a.ts', 'src/b.ts']);
  assert.equal(glob.hitCount, 2);
  const grep = run(parser(), [
    assistant([toolUse('t2', 'Grep', { pattern: 'foo', path: '/ws', output_mode: 'content' })]),
    result('t2', '/ws/a.ts:3:foo bar\n/ws/b.ts:9:foo', 'raw'),
  ]).events[0];
  assert.deepEqual(grep.hits.map((h) => [h.file, h.line]), [['a.ts', 3], ['b.ts', 9]]);
});

test('scratch locations are left out; workspace files are not', () => {
  const { events } = run(parser(), [
    assistant([
      toolUse('t1', 'Read', { file_path: '/tmp/scratch/out.log' }),
      toolUse('t2', 'Bash', { command: 'cat /tmp/x.txt > /tmp/y.txt && cat /ws/tmp/keep.txt' }),
    ]),
    result('t1', 'x', { type: 'text', file: { filePath: '/tmp/scratch/out.log', startLine: 1, numLines: 1, totalLines: 1 } }),
    result('t2', '', { stdout: '' }),
  ]);
  assert.deepEqual(events.map((e) => e.file), ['tmp/keep.txt']);
});

test('paths: relative inside the workspace, absolute outside, relative inputs use the record cwd', () => {
  assert.equal(displayPath('/ws', '/ws/src/a.ts'), 'src/a.ts');
  assert.equal(displayPath('/ws', '/ws'), '.');
  assert.equal(displayPath('/ws', '/other/repo/a.ts'), '/other/repo/a.ts');
  const { events } = run(parser(), [
    assistant([toolUse('t1', 'Read', { file_path: 'a.ts' })]),
    result('t1', 'x', { type: 'text', file: { filePath: 'a.ts', startLine: 1, numLines: 1 } }, { cwd: '/other/repo' }),
  ]);
  assert.equal(events[0].file, '/other/repo/a.ts');
});

test('the words before a tool call become its caption, once, with markdown stripped', () => {
  const { events } = run(parser(), [
    assistant([text('I will check **the mapping** in `gantt.ts` first.'), toolUse('t1', 'Read', { file_path: '/ws/a.ts' }), toolUse('t2', 'Read', { file_path: '/ws/b.ts' })]),
    result('t1', 'x', { type: 'text', file: { filePath: '/ws/a.ts', startLine: 1, numLines: 1 } }),
    result('t2', 'x', { type: 'text', file: { filePath: '/ws/b.ts', startLine: 1, numLines: 1 } }),
  ]);
  assert.equal(events[0].caption, 'I will check the mapping in gantt.ts first.');
  assert.equal(events[1].caption, undefined);
});

test('long captions are shortened to one line', () => {
  const { events } = run(parser(), [
    assistant([text(`line one\nline two ${'word '.repeat(100)}`), toolUse('t1', 'Read', { file_path: '/ws/a.ts' })]),
    result('t1', 'x', { type: 'text', file: { filePath: '/ws/a.ts', startLine: 1, numLines: 1 } }),
  ]);
  assert.ok(events[0].caption.length <= 220);
  assert.ok(!events[0].caption.includes('\n'));
  assert.ok(events[0].caption.endsWith('…'));
});

test('subagent events carry the agent type and id', () => {
  const { events } = run(parser('planner-fe', 'abc123'), [
    assistant([toolUse('s1', 'Read', { file_path: '/ws/a.ts' })]),
    result('s1', 'x', { type: 'text', file: { filePath: '/ws/a.ts', startLine: 1, numLines: 1 } }),
  ]);
  assert.equal(events[0].agent, 'planner-fe');
  assert.equal(events[0].agentId, 'abc123');
});

test('Agent tool calls announce the subagent', () => {
  const { meta, events } = run(parser(), [
    assistant([toolUse('t1', 'Agent', { subagent_type: 'planner-fe', description: 'Plan #1', prompt: 'p' })]),
    result('t1', 'launched', { agentId: 'abc123', status: 'async_launched' }),
  ]);
  assert.equal(events.length, 0);
  assert.deepEqual(meta.find((m) => m.kind === 'spawn').spawn, { toolUseId: 't1', agentType: 'planner-fe', description: 'Plan #1', agentId: 'abc123' });
});

test('a tool result is used once', () => {
  const read = result('t1', 'x', { type: 'text', file: { filePath: '/ws/a.ts', startLine: 1, numLines: 1 } });
  const { events } = run(parser(), [assistant([toolUse('t1', 'Read', { file_path: '/ws/a.ts' })]), read, read]);
  assert.equal(events.length, 1);
});

test('usage, titles, PR links, cost and context are extracted', () => {
  const { usage, meta } = run(parser(), [
    { type: 'ai-title', aiTitle: 'Issue 1', timestamp: '2026-10-18T07:00:00.000Z' },
    { type: 'pr-link', prNumber: 7, prUrl: 'https://x/pr/7', prRepository: 'o/r' },
    { type: 'cost-state', totalCostUSD: 1.5, totalDuration: 9000, totalLinesAdded: 4, totalLinesRemoved: 1 },
    { ...assistant([text('hi')]), cwd: '/ws', gitBranch: 'feat/x' },
  ]);
  assert.deepEqual(usage[0], { messageId: usage[0].messageId, model: 'claude-opus-5-5', input: 10, output: 20, cacheRead: 100, cacheCreate: 5 });
  assert.deepEqual(meta.filter((m) => m.kind !== 'context'), [
    { kind: 'title', title: 'Issue 1' },
    { kind: 'pr', number: 7, url: 'https://x/pr/7', repository: 'o/r' },
    { kind: 'cost', costUSD: 1.5, durationMs: 9000, linesAdded: 4, linesRemoved: 1 },
  ]);
  assert.deepEqual(meta.find((m) => m.kind === 'context'), { kind: 'context', cwd: '/ws', gitBranch: 'feat/x' });
});

test('synthetic-model messages carry no usage', () => {
  const rec = assistant([text('x')]);
  rec.message.model = '<synthetic>';
  assert.equal(run(parser(), [rec]).usage.length, 0);
});

test('unknown or malformed records are skipped without throwing', () => {
  const p = parser();
  assert.equal(p.feed(null), null);
  assert.equal(p.feed('garbage'), null);
  assert.equal(p.feed([]), null);
  for (const rec of [{ type: 'attachment' }, { type: 'api-request-blob' }, { type: 'assistant' }, { type: 'assistant', message: 'x' }, { type: 'user', message: { content: 'plain string' } }, { type: 'user', message: { content: [{ type: 'tool_result' }] } }]) {
    const out = p.feed(rec);
    assert.deepEqual(out.events, []);
  }
});

test('failed tool calls are reported so they can be counted', () => {
  const { meta } = run(parser(), [
    assistant([toolUse('t1', 'Read', { file_path: '/ws/missing.ts' }), toolUse('t2', 'Bash', { command: 'false' })]),
    result('t1', 'File does not exist', 'Error: nope', {}, true),
    result('t2', 'exit 1', { stdout: '' }, {}, true),
  ]);
  assert.deepEqual(meta.filter((m) => m.kind === 'toolError').map((m) => m.tool), ['Read', 'Bash']);
});

test('CodeGraph explore calls are searches without hit data', () => {
  const { events } = run(parser(), [
    assistant([text('Map the area first.'), toolUse('t1', 'mcp__codegraph__codegraph_explore', { query: 'how do links work', projectPath: '/ws' })]),
    result('t1', 'long answer', undefined),
  ]);
  assert.deepEqual([events[0].op, events[0].tool, events[0].query, events[0].hitCount, events[0].caption], ['search', 'codegraph_explore', 'how do links work', undefined, 'Map the area first.']);
});
