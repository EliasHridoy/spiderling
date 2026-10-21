const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, Redactor, REDACTED } = require('../out/transcript/redact.js');

const masked = (s) => redact(s).text;

test('masks well-known token formats', () => {
  const cases = [
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_' + '11ABCDEFG0abcdefghijklmnop_qrstuvwxyz',
    'xoxb-' + '1234567890-abcdefghij',
    'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz',
    'sk_live_' + 'abcdefghijklmnop1234',
    'AIza' + 'SyA-abcdefghijklmnopqrstuvwxyz01234',
    'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
    'glpat-' + 'abcdefghijklmnopqrstuv',
    'eyJhbGci' + 'OiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  ];
  for (const token of cases) {
    const out = masked(`use ${token} for the call`);
    assert.ok(!out.includes(token), `leaked: ${token}`);
    assert.match(out, /^use \[redacted\] for the call$/);
  }
});

test('masks private key blocks, including a truncated one', () => {
  const full = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY----- done';
  assert.equal(masked(full), `${REDACTED} private key done`);
  const cut = 'key: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN';
  assert.ok(!masked(cut).includes('MIIEvQ'));
});

test('masks credentials inside URLs but keeps the host', () => {
  assert.equal(masked('git clone https://bob:hunter2@github.com/o/r.git'), 'git clone https://[redacted]@github.com/o/r.git');
  assert.equal(masked('postgres://admin:s3cret@db:5432/app'), 'postgres://[redacted]@db:5432/app');
  assert.equal(masked('see https://github.com/o/r for details'), 'see https://github.com/o/r for details');
});

test('masks authorization headers and bearer tokens', () => {
  assert.equal(masked('curl -H "Authorization: Bearer abcdef123456" x'), 'curl -H "Authorization: Bearer [redacted]" x');
  assert.equal(masked('Authorization=Basic dXNlcjpwYXNz'), 'Authorization=Basic [redacted]');
  assert.equal(masked('sent bearer abcdefghijklmnop1234 along'), 'sent bearer [redacted] along');
  assert.equal(masked('the authorization header is missing'), 'the authorization header is missing');
});

test('masks name=value assignments of secret-looking names', () => {
  assert.equal(masked('export GH_TOKEN=abcd1234efgh'), 'export GH_TOKEN=[redacted]');
  assert.equal(masked('DB_PASSWORD=hunter22'), 'DB_PASSWORD=[redacted]');
  assert.equal(masked('{"apiKey": "k-123456789"}'), '{"apiKey": "[redacted]"}');
  assert.equal(masked("client_secret: 'zzzzzzzzzz'"), "client_secret: '[redacted]'");
  assert.equal(masked('//registry.npmjs.org/:_authToken=abcdef123456'), '//registry.npmjs.org/:_authToken=[redacted]');
  assert.equal(masked('password: hunter2'), 'password: [redacted]');
});

test('masks secret CLI flags and curl -u', () => {
  assert.equal(masked('mytool --password hunter22 --verbose'), 'mytool --password [redacted] --verbose');
  assert.equal(masked('mytool --api-key=abcd1234'), 'mytool --api-key=[redacted]');
  assert.equal(masked('curl -u admin:hunter22 https://x.test'), 'curl -u [redacted] https://x.test');
});

test('leaves references, placeholders and prose alone', () => {
  const same = [
    'export GH_TOKEN=$GH_TOKEN',
    'token=${TOKEN}',
    'password: string',
    'apiKey: process.env.API_KEY',
    'secret=<your-secret>',
    'the token: expired',
    'password=changeme',
    'Read the credentials from the vault',
    'commit 3d0f5ce8a1b2c3d4e5f60718293a4b5c6d7e8f90',
    'session 3f403bdc-702d-45ab-ae39-10cc9f209396',
    'token=fetchToken()',
    'src/auth/token.service.ts:42',
  ];
  for (const s of same) {
    assert.equal(masked(s), s, `changed: ${s}`);
  }
});

test('does not double-mask or count references', () => {
  const once = redact('GH_TOKEN=abcd1234efgh');
  assert.equal(once.count, 1);
  assert.equal(masked(once.text), once.text);
  assert.equal(redact('GH_TOKEN=$GH_TOKEN').count, 0);
});

test('counts every masked secret', () => {
  const r = redact('a ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789 b DB_PASSWORD=hunter22 c');
  assert.equal(r.count, 2);
});

test('Redactor keeps a running total and passes empty values through', () => {
  const r = new Redactor();
  assert.equal(r.text(undefined), undefined);
  assert.equal(r.text(''), '');
  assert.equal(r.text('plain'), 'plain');
  r.text('DB_PASSWORD=hunter22');
  r.text('xoxb-' + '1234567890-abcdefghij');
  assert.equal(r.count, 2);
});
