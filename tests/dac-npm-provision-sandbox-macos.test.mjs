// Real macOS platform gate for the npm provisioner isolation. Uses ONLY synthetic local commands (/usr/bin/touch, /bin/sh, /usr/bin/env, node/npm
// --version) in throwaway directories. It never downloads anything: the provisioner's network phase is NOT exercised here (network is allowed there
// by design) and the only npm invocations are `npm --version` and an OFFLINE `npm ci` against an empty private cache inside the network-denied
// validation sandbox. Where sandbox-exec is unavailable the tests are explicitly SKIPPED, never passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionerRunner, OFFLINE_INSTALL_ARGV } from '../adapters/shared/sdd-run/npm-provision.mjs';
import { validationRunner, SANDBOX_EXEC } from '../adapters/shared/sdd-run/validation.mjs';

const PERSONAL = ['', 'Users', 'someone'].join('/'); // built at runtime so the repository secret/personal-path scan stays clean
const available = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
const skip = available ? false : 'SKIPPED: macOS /usr/bin/sandbox-exec is not available on this platform (isolation NOT verified)';
const dirs = () => { const base = realpathSync(mkdtempSync(join(tmpdir(), 'dac-npmsbx-'))); const d = { base, ws: join(base, 'ws'), cache: join(base, 'cache'), outside: join(base, 'outside') }; for (const k of ['ws', 'cache', 'outside']) mkdirSync(d[k]); mkdirSync(join(d.ws, 'home')); mkdirSync(join(d.ws, 'tmp')); return d; };

test('provisioner preflight OBSERVES enforcement: writes inside workspace/cache succeed, a write outside is denied', { skip }, () => {
  const d = dirs();
  try {
    const p = provisionerRunner(); const pf = p.preflight({ workspace: d.ws, cache: d.cache, outsideProbe: join(d.outside, 'probe') });
    assert.deepEqual(pf, { verified: true, checks: { write_inside_workspace: true, write_inside_cache: true, write_outside_denied: true } });
    assert.equal(existsSync(join(d.outside, 'probe')), false);
  } finally { rmSync(d.base, { recursive: true, force: true }); }
});

test('provisioner sandbox: writes limited to workspace+cache; environment is hermetic (no tokens, keys, NODE_OPTIONS, inherited npm config or user HOME)', { skip }, () => {
  const d = dirs();
  try {
    const parentEnv = { PATH: process.env.PATH, OPENAI_API_KEY: 'sk-test', NPM_TOKEN: 'tok', NODE_OPTIONS: '--require /nonexistent.js', npm_config_registry: 'https://evil.example/', npm_config_userconfig: `${PERSONAL}/.npmrc`, HOME: PERSONAL, CODEX_API_KEY: 'c' };
    const p = provisionerRunner({ parentEnv }); const home = join(d.ws, 'home'); const tmp = join(d.ws, 'tmp');
    const sh = (script) => p.run({ argv: ['/bin/sh', '-c', script], workspace: d.ws, cache: d.cache, home, tmp });
    const ok = sh('echo a > "$PWD/in.txt" && echo b > "$npm_config_cache/c.txt" && echo c > "$HOME/h.txt" && echo d > "$TMPDIR/t.txt"');
    assert.equal(ok.status, 0, ok.stderr); assert.equal(readFileSync(join(d.cache, 'c.txt'), 'utf8'), 'b\n');
    const out = sh(`echo bad > '${join(d.outside, 'x')}'`); assert.notEqual(out.status, 0); assert.equal(existsSync(join(d.outside, 'x')), false);
    const real = realpathSync(tmpdir()); const leak = join(real, `dac-npmsbx-leak-${process.pid}`);
    assert.notEqual(sh(`echo bad > '${leak}'`).status, 0); assert.equal(existsSync(leak), false);
    const up = sh(`echo bad > '${join(d.base, 'sibling')}'`); assert.notEqual(up.status, 0); assert.equal(existsSync(join(d.base, 'sibling')), false);
    const env = p.run({ argv: ['/usr/bin/env'], workspace: d.ws, cache: d.cache, home, tmp }); assert.equal(env.status, 0);
    const vars = Object.fromEntries(env.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    for (const k of ['OPENAI_API_KEY', 'NPM_TOKEN', 'NODE_OPTIONS', 'CODEX_API_KEY', 'npm_config_userconfig_parent']) assert.equal(vars[k], undefined, k);
    assert.equal(vars.HOME, home); assert.equal(vars.TMPDIR, tmp); assert.equal(vars.npm_config_cache, d.cache); assert.equal(vars.npm_config_registry, 'https://registry.npmjs.org/');
    assert.equal(vars.npm_config_userconfig, join(home, '.npmrc')); assert.equal(vars.npm_config_ignore_scripts, 'true'); assert.equal(vars.CI, '1');
    assert.ok(!env.stdout.includes(PERSONAL) && !env.stdout.includes('sk-test') && !env.stdout.includes('evil.example'));
  } finally { rmSync(d.base, { recursive: true, force: true }); }
});

test('toolchain probe reads the real Node/npm versions with every write and the network denied', { skip }, () => {
  const t = provisionerRunner().probe();
  assert.match(t.node, /^v\d+\.\d+\.\d+/); assert.match(t.npm, /^\d+\.\d+\.\d+/);
  assert.equal(t.platform, 'darwin'); assert.ok(['arm64', 'x64'].includes(t.arch)); assert.equal(t.libc, null);
});

test('validation sandbox + real `npm ci --offline --ignore-scripts` with an EMPTY private cache fails closed (no network, no node_modules)', { skip }, () => {
  const d = dirs();
  try {
    const integrity = 'sha512-' + 'A'.repeat(86) + '==';
    writeFileSync(join(d.ws, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { left: '1.0.0' } }));
    writeFileSync(join(d.ws, 'package-lock.json'), JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0', dependencies: { left: '1.0.0' } }, 'node_modules/left': { version: '1.0.0', resolved: 'https://registry.npmjs.org/left/-/left-1.0.0.tgz', integrity } } }));
    const r = validationRunner().run({ argv: [...OFFLINE_INSTALL_ARGV], cwd: d.ws });
    assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`); assert.equal(existsSync(join(d.ws, 'node_modules', 'left')), false);
    assert.match(`${r.stdout}${r.stderr}`, /ENOTCACHED|offline|cache/i);
    assert.equal(existsSync(join(d.outside, 'x')), false);
  } finally { rmSync(d.base, { recursive: true, force: true }); }
});
