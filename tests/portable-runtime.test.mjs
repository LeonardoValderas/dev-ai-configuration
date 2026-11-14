import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { available, environment, profile, invocation, runProbe } from './support/portable-runtime.mjs';
import { generatePortable } from '../adapters/shared/portable.mjs';
import { apply as codexApply } from '../adapters/codex/lib/apply.mjs';
import { apply as cursorApply } from '../adapters/cursor/lib/apply.mjs';
test('DECLARATIVE: native runtime environment has no credentials; all mutable homes are disposable', () => {
  const env = environment('/tmp/disposable');
  for (const [k, v] of Object.entries(env)) if (!['PATH', 'NO_COLOR'].includes(k)) assert.ok(v.startsWith('/tmp/disposable/'));
  assert.ok(!Object.keys(env).some((k) => /KEY|TOKEN|SECRET|AUTH|PROXY/.test(k)));
  const sb = profile('/tmp/disposable', ['/synthetic']);
  assert.match(sb, /\(deny network\*\)/); assert.match(sb, /\(deny file-write\*\)/);
  for (const p of ['.claude', '.codex', '.cursor']) assert.ok(sb.includes(`(deny file-read* (subpath "/synthetic/${p}"))`));
});
test('SECURITY: runtime probes reject prompts, authentication, overrides and bypass flags', () => {
  for (const cmd of ['codex', 'agent']) {
    for (const args of [[], ['login'], ['exec', 'hello'], ['--help', '--yolo'], ['--version', '--config', 'x'], ['--force'], ['--api-key', 'x']]) assert.throws(() => invocation(cmd, args), /BLOCKED/);
    invocation(cmd, ['--help']); invocation(cmd, ['--version']);
  }
  assert.throws(() => invocation('sh', ['--help']), /BLOCKED/);
});
const sandbox = available();
for (const [cmd, provider, apply] of [['codex', 'codex', codexApply], ['agent', 'cursor', cursorApply]]) {
  const installed = sandbox && spawnSync('/usr/bin/which', [cmd], { env: { PATH: process.env.PATH } }).status === 0;
  for (const flag of ['--version', '--help']) test(`CLI-INTEGRATION: isolated ${cmd} ${flag} (no authentication)`, { skip: !sandbox ? 'BLOCKED-UNVERIFIED: macOS sandbox unavailable; no unsandboxed fallback' : !installed ? `${cmd} unavailable` : false }, (t) => {
    const r = runProbe(cmd, [flag], (ws) => apply(ws, generatePortable(provider)));
    assert.equal(r.status, 0, r.stderr); assert.ok(r.stdout.trim());
    if (flag === '--help') assert.match(r.stdout, /usage|options/i);
    t.diagnostic(`${r.evidence}; ${r.protectedProfiles}; ${flag === '--version' ? r.stdout.trim() : 'help returned'}`);
  });
}
test('AUTHENTICATED-ENFORCEMENT: explicitly unverified; no model calls permitted', { skip: 'Forbidden by Phase 2H scope; declarative policy and help/version are not runtime enforcement evidence' }, () => {});
