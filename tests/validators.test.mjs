import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validatePaths, loadSchemas, REPO_ROOT } from '../installer/lib/run.mjs';
import { assertSupportedSchema, validateSchema } from '../installer/lib/schema.mjs';
import { scanSecrets } from '../installer/lib/checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const CLI = join(REPO_ROOT, 'installer', 'validate.mjs');

// Credential-shaped and machine-specific values are composed at test time so
// that no such literal exists in the repository.
const TOKENS = {
  ABS_UNIX: '/' + 'home' + '/synthetic-user',
  ABS_WIN: 'C:' + '\\' + 'Users' + '\\synthetic-user',
  AWS: 'AK' + 'IA' + 'IOSFODNN7' + 'EXAMPLE',
  GH: 'gh' + 'p_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6',
  STRIPE: 'sk' + '_live_' + '0123456789abcdefABCDEF',
  PEM: '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----',
  LITERAL: 'Zx81QpLm20Vb77Tr',
  URLCRED: 'https://' + 'svc:' + 'hunter2hunter2' + '@db.example.com/x',
};
function materialize(dir) {
  const tmp = mkdtempSync(join(tmpdir(), 'dac-fixture-'));
  cpSync(dir, tmp, { recursive: true });
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (lstatSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.json')) {
        const t = readFileSync(p, 'utf8');
        const r = t.replace(/@@([A-Z_]+)@@/g, (_, k) => { assert.ok(k in TOKENS, `unknown token ${k}`); return JSON.stringify(TOKENS[k]).slice(1, -1); });
        if (r !== t) writeFileSync(p, r);
      }
    }
  };
  walk(tmp);
  return tmp;
}
const snapshot = (dir) => {
  const h = createHash('sha256');
  const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (lstatSync(p).isDirectory()) walk(p); else h.update(p + readFileSync(p)); } };
  walk(dir);
  return h.digest('hex');
};
const matrix = join(REPO_ROOT, 'compatibility', 'matrix.json');
const run = (dir) => validatePaths([dir], { matrixPath: matrix });
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('schemas only use keywords the validator implements', () => {
  for (const [name, s] of loadSchemas()) assert.doesNotThrow(() => assertSupportedSchema(s, name), name);
});

test('real manifests and compatibility matrix pass', () => {
  const r = validatePaths([join(REPO_ROOT, 'standards', 'manifests'), join(REPO_ROOT, 'compatibility')]);
  assert.deepEqual(r.errors, []);
  assert.ok(r.filesChecked >= 1);
});

test('schema validator detects missing fields and wrong types', () => {
  const reg = loadSchemas();
  const s = reg.get('task-contract.schema.json');
  const codes = (d) => new Set(validateSchema(s, d, reg).map((e) => e.code));
  assert.ok(codes({}).has('SCHEMA_MISSING_FIELD'));
  assert.ok(codes({ objective: 5 }).has('SCHEMA_WRONG_TYPE'));
});

const validCases = readdirSync(join(FIX, 'valid')).sort();
const expectations = JSON.parse(readFileSync(join(FIX, 'invalid', 'expectations.json'), 'utf8'));
const invalidCases = readdirSync(join(FIX, 'invalid')).filter((n) => n !== 'expectations.json').sort();

for (const name of validCases) {
  test(`valid fixture passes: ${name}`, () => {
    const tmp = materialize(join(FIX, 'valid', name));
    try { assert.deepEqual(run(tmp).errors, []); } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('every invalid fixture has an expectation and vice versa', () => {
  assert.deepEqual(invalidCases, Object.keys(expectations).sort());
});

for (const name of invalidCases) {
  test(`invalid fixture fails for expected reason: ${name}`, () => {
    const exp = expectations[name];
    const tmp = materialize(join(FIX, 'invalid', name));
    try {
      const { errors } = run(tmp);
      assert.deepEqual([...new Set(errors.map((e) => e.code))].sort(), [...exp.codes].sort(), JSON.stringify(errors));
      if (exp.rule) assert.ok(errors.some((e) => e.rule === exp.rule), `expected rule ${exp.rule}: ${JSON.stringify(errors)}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('each documented error code is covered by an invalid fixture', () => {
  const covered = new Set(Object.values(expectations).flatMap((e) => e.codes));
  for (const c of ['SCHEMA_MISSING_FIELD', 'SCHEMA_WRONG_TYPE', 'SCHEMA_UNKNOWN_FIELD', 'SCHEMA_INVALID_VALUE', 'SCHEMA_CONSTRAINT', 'INVALID_JSON', 'UNKNOWN_KIND', 'FILE_STRUCTURE', 'MISSING_REFERENCE', 'DUPLICATE_ID', 'DANGEROUS_PERMISSION', 'ABSOLUTE_PATH', 'PATH_TRAVERSAL', 'SECRET_PATTERN', 'UNSUPPORTED_COMPATIBILITY', 'RESULT_INCONSISTENT']) {
    assert.ok(covered.has(c), c);
  }
});

test('CLI exits 0 on valid, 1 on invalid, 2 on usage error; never modifies files', () => {
  const good = materialize(join(FIX, 'valid', 'full-set'));
  const bad = materialize(join(FIX, 'invalid', 'danger-force-push'));
  try {
    const before = [snapshot(good), snapshot(bad)];
    const g = cli('--matrix', matrix, good);
    const b = cli('--matrix', matrix, bad);
    const j = cli('--json', '--matrix', matrix, bad);
    assert.equal(g.status, 0, g.stdout + g.stderr);
    assert.equal(b.status, 1);
    assert.match(b.stdout, /DANGEROUS_PERMISSION\[force-push\]/);
    assert.equal(JSON.parse(j.stdout).ok, false);
    assert.equal(cli('--bogus').status, 2);
    assert.equal(cli(join(good, 'does-not-exist')).status, 1);
    assert.deepEqual([snapshot(good), snapshot(bad)], before);
  } finally { rmSync(good, { recursive: true, force: true }); rmSync(bad, { recursive: true, force: true }); }
});

test('CLI default run on the repository passes', () => {
  const r = cli();
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('validator sources perform no write operations', () => {
  const forbidden = /\b(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmSync|rmdirSync|mkdirSync|renameSync|copyFileSync|createWriteStream|chmodSync|child_process|fetch\(|http\.request|https\.request)/;
  const dir = join(REPO_ROOT, 'installer');
  const walk = (d) => readdirSync(d).flatMap((n) => (lstatSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.mjs') ? [join(d, n)] : []));
  for (const f of walk(dir)) assert.doesNotMatch(readFileSync(f, 'utf8'), forbidden, f);
});

test('repository contains no personal paths or secret-shaped values', () => {
  const personal = [new RegExp(['/Us', 'ers/'].join('')), new RegExp(['/ho', 'me/'].join('')), new RegExp(['C:', '\\\\\\\\Us', 'ers'].join(''))];
  const skip = new Set(['.git', 'node_modules']);
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { if (skip.has(n)) continue; const p = join(d, n); lstatSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(REPO_ROOT);
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    for (const re of personal) assert.doesNotMatch(t, re, f);
    if (!f.endsWith('.test.mjs') && !f.includes(`${join('installer', 'lib')}`)) assert.deepEqual(scanSecrets(t), [], f);
  }
});

test('secret scanner allows env placeholders and names', () => {
  assert.deepEqual(scanSecrets('api_key=$API_KEY and token: ${TOKEN}'), []);
  assert.deepEqual(scanSecrets('env var API_TOKEN'), []);
});
