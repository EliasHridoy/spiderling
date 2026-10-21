const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBash, parseHits, attributeHits } = require('../out/transcript/bashParse.js');

// [kind, tool, file, startLine, endLine] per action
const acts = (cmd, cwd = '/w') => parseBash(cmd, cwd).map((a) => [a.kind, a.tool, a.file, a.startLine, a.endLine]);

test('grep -rn: search root resolved against cwd, pipe consumer ignored', () => {
  const a = parseBash('cd /repo && grep -rn "foo\\|bar" src --include=*.ts | head -20', '/w');
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'search');
  assert.equal(a[0].tool, 'grep');
  assert.equal(a[0].file, '/repo/src');
  assert.equal(a[0].query, 'foo\\|bar');
});

test('grep with -e patterns and -l', () => {
  const a = parseBash('grep -rl -e foo -e bar src', '/w');
  assert.equal(a[0].query, 'foo | bar');
  assert.equal(a[0].listsFiles, true);
  assert.equal(a[0].file, '/w/src');
});

test('grep -r without a path searches the cwd; grep without -r on stdin is not a search', () => {
  assert.deepEqual(acts('grep -rn foo'), [['search', 'grep', '/w', undefined, undefined]]);
  assert.deepEqual(acts('grep foo'), []);
  assert.deepEqual(acts('cat build.log | grep foo'), [['read', 'cat', '/w/build.log', undefined, undefined]]);
});

test('rg flags that take a value do not become the search root', () => {
  assert.deepEqual(acts('rg -n "useState" -g "*.tsx" web/'), [['search', 'rg', '/w/web', undefined, undefined]]);
  assert.deepEqual(acts('rg --glob "*.ts" foo lib'), [['search', 'rg', '/w/lib', undefined, undefined]]);
});

test('git grep', () => {
  const a = parseBash('git grep -n foo -- src', '/w');
  assert.equal(a[0].tool, 'git grep');
  assert.equal(a[0].file, '/w/src');
});

test('sed -n prints an exact range; several ranges widen it', () => {
  assert.deepEqual(acts('sed -n "120,180p" a.ts'), [['read', 'sed', '/w/a.ts', 120, 180]]);
  assert.deepEqual(acts("sed -n '42p' a.ts"), [['read', 'sed', '/w/a.ts', 42, 42]]);
  assert.deepEqual(acts("sed -n '10,+20p' a.ts"), [['read', 'sed', '/w/a.ts', 10, 30]]);
  assert.deepEqual(acts("sed -n -e '5,8p' -e '20,25p' a.ts"), [['read', 'sed', '/w/a.ts', 5, 25]]);
});

test('sed -i writes the file; sed on stdin is ignored', () => {
  assert.deepEqual(acts("sed -i 's/a/b/' f.ts"), [['write', 'sed', '/w/f.ts', undefined, undefined]]);
  assert.deepEqual(acts("cat a.ts | sed 's/a/b/'"), [['read', 'cat', '/w/a.ts', undefined, undefined]]);
});

test('cat / head / tail', () => {
  assert.deepEqual(acts('cat -n a.ts b.ts'), [
    ['read', 'cat', '/w/a.ts', undefined, undefined],
    ['read', 'cat', '/w/b.ts', undefined, undefined],
  ]);
  assert.deepEqual(acts('head -n 40 src/a.ts'), [['read', 'head', '/w/src/a.ts', 1, 40]]);
  assert.deepEqual(acts('head -5 a.ts'), [['read', 'head', '/w/a.ts', 1, 5]]);
  assert.deepEqual(acts('head a.ts'), [['read', 'head', '/w/a.ts', 1, 10]]);
  assert.deepEqual(acts('tail -5 b.ts'), [['read', 'tail', '/w/b.ts', undefined, undefined]]);
});

test('find -name keeps a name matcher and ignores a piped find', () => {
  const a = parseBash('find src -name "*.spec.ts" -newer x', '/w');
  assert.equal(a[0].kind, 'search');
  assert.equal(a[0].file, '/w/src');
  assert.equal(a[0].query, '*.spec.ts');
  assert.ok(a[0].nameMatcher.test('a.spec.ts'));
  assert.ok(!a[0].nameMatcher.test('a.ts'));
  assert.deepEqual(acts('ls | find . -name x'), []);
});

test('find that deletes or executes is not a search', () => {
  assert.deepEqual(acts('find dist -mindepth 1 -delete'), []);
  assert.deepEqual(acts('find . -name "*.log" -exec rm {} ;'), []);
});

test('redirects and tee write files; fd duplication and /dev/null do not', () => {
  assert.deepEqual(acts('echo hi >> log.txt 2>&1'), [['write', 'redirect', '/w/log.txt', undefined, undefined]]);
  assert.deepEqual(acts('echo hi > out.txt'), [['write', 'redirect', '/w/out.txt', undefined, undefined]]);
  assert.deepEqual(acts('make 2>&1 > /dev/null'), []);
  assert.deepEqual(acts('echo x | tee out.txt'), [['write', 'tee', '/w/out.txt', undefined, undefined]]);
});

test('heredoc bodies are skipped, the command after them still parsed', () => {
  const cmd = "cat > out.md <<'EOF'\nhello > not-a-file\ncat src/inside.ts\nEOF\ncat src/x.ts";
  assert.deepEqual(acts(cmd), [
    ['write', 'redirect', '/w/out.md', undefined, undefined],
    ['read', 'cat', '/w/src/x.ts', undefined, undefined],
  ]);
});

test('variables are expanded when known and skipped when not', () => {
  assert.deepEqual(acts('W=/repo/app; sed -n 1,5p $W/a.ts'), [['read', 'sed', '/repo/app/a.ts', 1, 5]]);
  assert.deepEqual(acts('cat $UNSET/a.ts'), []);
  assert.deepEqual(acts('cat ${NOPE}/a.ts'), []);
  assert.deepEqual(acts('P=src; cat "$P/a.ts"'), [['read', 'cat', '/w/src/a.ts', undefined, undefined]]);
});

test('command substitution and loops are never guessed at', () => {
  assert.deepEqual(acts('cat $(find . -name a.ts)'), []);
  assert.deepEqual(acts('echo $(cat secret) > /dev/null; ls -la'), []);
  assert.deepEqual(acts('for f in a b; do cat $f; done'), []);
});

test('cd changes the directory for what follows', () => {
  assert.deepEqual(acts('cd src && cat a.ts'), [['read', 'cat', '/w/src/a.ts', undefined, undefined]]);
  assert.deepEqual(acts('cd /abs/dir; cat ../b.ts'), [['read', 'cat', '/abs/b.ts', undefined, undefined]]);
});

test('separators, env prefixes, keywords, quoting and comments', () => {
  assert.deepEqual(acts('cat a.ts && cat b.ts || cat c.ts; cat d.ts').map((x) => x[2]), ['/w/a.ts', '/w/b.ts', '/w/c.ts', '/w/d.ts']);
  assert.deepEqual(acts('FOO=1 BAR=2 cat a.ts'), [['read', 'cat', '/w/a.ts', undefined, undefined]]);
  assert.deepEqual(acts('time cat a.ts'), [['read', 'cat', '/w/a.ts', undefined, undefined]]);
  assert.deepEqual(acts('cat "my file.ts"'), [['read', 'cat', '/w/my file.ts', undefined, undefined]]);
  assert.deepEqual(acts('cat a.ts # cat b.ts'), [['read', 'cat', '/w/a.ts', undefined, undefined]]);
  assert.deepEqual(acts("cat 'a b'/c.ts"), [['read', 'cat', '/w/a b/c.ts', undefined, undefined]]);
});

test('unrelated commands and noise produce nothing', () => {
  assert.deepEqual(acts('npm test'), []);
  assert.deepEqual(acts('git status -sb'), []);
  assert.deepEqual(acts('cat /dev/null'), []);
  assert.deepEqual(acts(''), []);
});

test('each action remembers the directory it ran in', () => {
  const a = parseBash('cd /repo/sub && grep -rn foo .', '/w');
  assert.equal(a[0].cwd, '/repo/sub');
});

// ---- hits ----------------------------------------------------------------

test('parseHits understands path:line:text, line:text, path:text and bare paths', () => {
  const root = { file: '/w/src/a.ts', listsFiles: false };
  assert.deepEqual(parseHits('src/a.ts:12:  const x = 1;\nsrc/b.ts:7:foo', root, '/w'), [
    { file: '/w/src/a.ts', line: 12, text: '  const x = 1;' },
    { file: '/w/src/b.ts', line: 7, text: 'foo' },
  ]);
  assert.deepEqual(parseHits('12:  const x = 1;\n30:foo', root, '/w'), [
    { file: '/w/src/a.ts', line: 12, text: '  const x = 1;' },
    { file: '/w/src/a.ts', line: 30, text: 'foo' },
  ]);
  assert.deepEqual(parseHits('src/a.ts:matched text', root, '/w'), [{ file: '/w/src/a.ts', text: 'matched text' }]);
  assert.deepEqual(parseHits('src/a.ts\nsrc/b.ts\n', { file: '/w', listsFiles: true }, '/w'), [
    { file: '/w/src/a.ts' },
    { file: '/w/src/b.ts' },
  ]);
  assert.deepEqual(parseHits('--\n\n', root, '/w'), []);
});

test('attributeHits drops output that is not under the search root', () => {
  const s = parseBash('cd /w && grep -rn foo src; ls /other', '/w').filter((a) => a.kind === 'search');
  const [hits] = attributeHits('src/a.ts:3:foo\n/other/x.ts:1:foo\n', s, '/w');
  assert.deepEqual(hits.map((h) => h.file), ['/w/src/a.ts']);
});

test('attributeHits splits the output of several searches by pattern, once each', () => {
  const s = parseBash('grep -rn foo src; grep -rn bar src', '/w').filter((a) => a.kind === 'search');
  const out = 'src/a.ts:1:has foo here\nsrc/b.ts:2:has bar here\nsrc/c.ts:3:foo and bar\n';
  const [first, second] = attributeHits(out, s, '/w');
  assert.deepEqual(first.map((h) => h.file), ['/w/src/a.ts', '/w/src/c.ts']);
  assert.deepEqual(second.map((h) => h.file), ['/w/src/b.ts']);
});

test('attributeHits keeps only find results whose name matches', () => {
  const s = parseBash('find src -name "*.spec.ts"', '/w');
  const [hits] = attributeHits('src/a.spec.ts\nsrc/a.ts\nsrc/deep/b.spec.ts\n', s, '/w');
  assert.deepEqual(hits.map((h) => h.file), ['/w/src/a.spec.ts', '/w/src/deep/b.spec.ts']);
});
