const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SymbolIndex } = require('../out/transcript/symbols.js');

// Build a miniature CodeGraph index: just the `nodes` table the lookup reads.
function repoWithIndex() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spiderling-sym-'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(repo, '.codegraph', 'codegraph.db'));
  db.exec('CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER)');
  const ins = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('1', 'file', 'a.ts', 'src/a.ts', 'src/a.ts', 1, 100);
  ins.run('2', 'class', 'Parser', 'Parser', 'src/a.ts', 10, 90);
  ins.run('3', 'method', 'parse', 'Parser.parse', 'src/a.ts', 20, 40);
  ins.run('4', 'constant', 'LIMIT', 'LIMIT', 'src/a.ts', 25, 25);
  ins.run('5', 'import', 'fs', 'fs', 'src/a.ts', 2, 2);
  db.close();
  return repo;
}

test('finds the innermost function/class around a line, ignoring files, imports and constants', () => {
  const repo = repoWithIndex();
  const idx = new SymbolIndex();
  try {
    assert.equal(idx.lookup(path.join(repo, 'src/a.ts'), 25), 'Parser.parse'); // inside the method, on a constant's line
    assert.equal(idx.lookup(path.join(repo, 'src/a.ts'), 15), 'Parser'); // in the class, outside the method
    assert.equal(idx.lookup(path.join(repo, 'src/a.ts'), 95), undefined); // only the file node covers it
    assert.equal(idx.lookup(path.join(repo, 'src/other.ts'), 25), undefined);
    assert.equal(idx.lookup(path.join(repo, 'src/deep/new/file.ts'), 1), undefined);
  } finally {
    idx.dispose();
  }
});

test('no index, or a file outside any indexed repo, simply gives no symbol', () => {
  const idx = new SymbolIndex();
  try {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'spiderling-bare-'));
    assert.equal(idx.lookup(path.join(bare, 'a.ts'), 1), undefined);
    assert.equal(idx.lookup('/definitely/not/here.ts', 1), undefined);
  } finally {
    idx.dispose();
  }
});

test('a corrupt index is ignored, not fatal', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spiderling-bad-'));
  fs.mkdirSync(path.join(repo, '.codegraph'));
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'not a database');
  const idx = new SymbolIndex();
  try {
    assert.equal(idx.lookup(path.join(repo, 'a.ts'), 1), undefined);
  } finally {
    idx.dispose();
  }
});
