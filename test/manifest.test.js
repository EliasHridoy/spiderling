const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// package.json declares commands, settings and views by id; the code uses the same
// ids as strings. A typo in either only shows up inside VS Code, so cross-check them.
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ts = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? ts(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
const source = ts(path.join(root, 'src')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const all = (re) => [...source.matchAll(re)].map((m) => m[1]);

test('every command the code registers is declared, and every declared command is registered', () => {
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  const registered = all(/registerCommand\(\s*'([^']+)'/g).sort();
  assert.deepEqual(registered, declared);
  for (const c of pkg.contributes.commands) {
    assert.match(c.command, /^spiderling\./);
    assert.equal(c.category, 'Spiderling');
    assert.ok(c.title && !c.title.startsWith('Spiderling'), `title "${c.title}" repeats the category`);
  }
});

test('commands used elsewhere in the code (status bar) are declared', () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const id of all(/\.command = '([^']+)'/g)) {
    assert.ok(declared.has(id), `${id} is not declared`);
  }
});

test('every setting the code reads is declared, and every declared setting is read', () => {
  const declared = Object.keys(pkg.contributes.configuration.properties);
  const read = new Set([
    ...all(/config\(\)\.get(?:<[^>]*>)?\(\s*'([^']+)'/g),
    ...all(/config\(\)\.update\(\s*'([^']+)'/g),
    ...all(/getConfiguration\('spiderling'\)\s*\.get(?:<[^>]*>)?\(\s*'([^']+)'/g),
  ].map((k) => `spiderling.${k}`));
  // settings listed as needing a reload are read via this list
  for (const m of source.matchAll(/RELOAD_SETTINGS = \[([\s\S]*?)\]/g)) {
    for (const k of m[1].matchAll(/'([A-Za-z]+)'/g)) read.add(`spiderling.${k[1]}`);
  }
  for (const k of read) assert.ok(declared.includes(k), `${k} is read but not declared`);
  for (const k of declared) assert.ok(read.has(k), `${k} is declared but never read`);
});

test('settings have defaults and descriptions, and the agent list matches the sources', () => {
  for (const [key, p] of Object.entries(pkg.contributes.configuration.properties)) {
    assert.ok(p.description, `${key} has no description`);
    assert.notEqual(p.default, undefined, `${key} has no default`);
  }
  const { ALL_SOURCES } = require('../out/transcript/sessionWatcher.js');
  const agents = pkg.contributes.configuration.properties['spiderling.agentSources'];
  assert.deepEqual([...agents.items.enum].sort(), [...ALL_SOURCES].sort());
  assert.deepEqual([...agents.default].sort(), [...ALL_SOURCES].sort());
});

test('the view, its menus and the editor menu point at declared things', () => {
  const view = pkg.contributes.views.explorer[0].id;
  assert.ok(all(/createTreeView\('([^']+)'/g).includes(view));
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const menu of Object.values(pkg.contributes.menus)) {
    for (const item of menu) {
      assert.ok(declared.has(item.command), `${item.command} in a menu is not declared`);
      if (item.when && item.when.includes('view ==')) assert.ok(item.when.includes(view));
    }
  }
});

test('the package points at files that exist and carries no leftovers', () => {
  assert.ok(fs.existsSync(path.join(root, pkg.main)), 'main is built');
  assert.ok(fs.existsSync(path.join(root, pkg.icon)));
  assert.equal(pkg.name, 'spiderling');
  assert.ok(!JSON.stringify(pkg).toLowerCase().includes('amlog'));
  for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md']) assert.ok(fs.existsSync(path.join(root, f)), f);
  assert.deepEqual(pkg.activationEvents, ['onStartupFinished']);
  assert.ok(!('dependencies' in pkg), 'no runtime dependencies');
});

test('the media scripts the panels load exist', () => {
  for (const f of all(/'media', '([^']+\.(?:js|css))'/g)) {
    assert.ok(fs.existsSync(path.join(root, 'media', f)), `media/${f}`);
  }
});
