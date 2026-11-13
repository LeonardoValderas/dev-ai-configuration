// Phase 2G.1 evidence guard: a green Linux CI must not be readable as macOS runtime verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runtimeEvidenceState, workflowClaimIsHonest } from './support/runtime-evidence.mjs';

const script = new URL('./support/runtime-evidence.mjs', import.meta.url).pathname;
const workflow = readFileSync(new URL('../.github/workflows/pr-validation.yml', import.meta.url), 'utf8');

test('SIMULATED: non-darwin platforms are always BLOCKED-UNVERIFIED', () => {
  const s = runtimeEvidenceState({ platform: 'linux', sandbox: () => true, base: () => '/tmp', reason: () => 'unsupported platform linux' });
  assert.equal(s.state, 'BLOCKED-UNVERIFIED');
  assert.match(s.detail, /skipped/);
});
test('SIMULATED: darwin without a usable sandbox is BLOCKED-UNVERIFIED', () => {
  const s = runtimeEvidenceState({ platform: 'darwin', sandbox: () => false, base: () => '/tmp', reason: () => 'nested sandbox' });
  assert.equal(s.state, 'BLOCKED-UNVERIFIED');
});
test('SIMULATED: workflow claim logic (claim needs a macOS runner)', () => {
  assert.equal(workflowClaimIsHonest('runs-on: ubuntu-latest').honest, true);
  assert.equal(workflowClaimIsHonest('runs-on: ubuntu-latest\nenv:\n  DAC_CLAIM_RUNTIME_VERIFIED: 1').honest, false);
  assert.equal(workflowClaimIsHonest('runs-on: macos-14\nenv:\n  DAC_CLAIM_RUNTIME_VERIFIED: 1').honest, true);
});
test('the PR workflow does not claim runtime verification it cannot perform', () => {
  const w = workflowClaimIsHonest(workflow);
  assert.equal(w.honest, true, 'pr-validation.yml claims runtime verification on a non-macOS runner');
});
test('the PR workflow reports the runtime evidence state as its own step', () => {
  assert.match(workflow, /runtime-evidence\.mjs/);
});
test('CLI: reports the state; a verification claim fails when the environment cannot back it', () => {
  const state = runtimeEvidenceState();
  const plain = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, new RegExp(`runtime evidence: ${state.state}`));
  const claim = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH, DAC_CLAIM_RUNTIME_VERIFIED: '1' } });
  assert.equal(claim.status, state.state === 'RUNTIME-CAPABLE' ? 0 : 1);
});
