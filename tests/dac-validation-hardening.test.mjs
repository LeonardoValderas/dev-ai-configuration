// Hardening of independent validation: (1) the reserved root .dac-validation in the audited tree fails closed before any copy/command,
// (2) environment variable NAMES/overrides (never values) are recorded and shown to the reviewer. Everything is simulated.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as H from './support/run-harness.mjs';
import { makeProject, impl, review, runs, reviewRunner, validationSim, implRunner, SCAFFOLD, ok, write } from './support/run-harness.mjs';
import { runIndependentValidation, validationRunner, environmentEvidence, FIXED_ENV_KEYS, INFRA_DIRS } from '../adapters/shared/sdd-run/validation.mjs';

after(() => { rmSync(H.scratch, { recursive: true, force: true }); });

async function ready() {
  const root = makeProject({ persistDocs: true });
  const r = await impl(root, { runner: implRunner(SCAFFOLD, ok()) });
  assert.equal(r.code, 0, r.out);
  const [run] = runs(root, r.st);
  return { root, st: r.st, run };
}
const attemptDir = (run) => join(run.dir, 'validation', 'attempt-1');
const readRec = (run) => JSON.parse(readFileSync(join(attemptDir(run), 'record.json'), 'utf8'));
const validate = (run, auditPatch = {}, v = validationSim()) => {
  const authz = JSON.parse(readFileSync(join(run.dir, 'authorization.json'), 'utf8'));
  return runIndependentValidation({ root: '/unused', run: run.run, contract: { validation_commands: authz.validation_commands }, audit: { ...run.audit, ...auditPatch }, runDir: run.dir, runner: v, clock: Date.now, checkBinding: () => [] });
};

test('reserved root .dac-validation in the audited tree fails closed before any copy or command; nothing is reclassified', async () => {
  const cases = {
    descendant: (wt) => write(wt, join(INFRA_DIRS.home, 'x'), 'product?\n'),
    'empty directory': (wt) => mkdirSync(join(wt, '.dac-validation')),
    symlink: (wt) => symlinkSync('/etc/hosts', join(wt, '.dac-validation')),
    'plain file': (wt) => write(wt, '.dac-validation', 'file\n'),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const { run } = await ready(); mutate(run.run.worktree.path);
    const v = validationSim(); const res = await validate(run, {}, v);
    assert.equal(res.ok, false, name); assert.equal(v.calls.length, 0, `${name}: no command may run`);
    assert.match(res.reasons.join(), /reserved DAC validation root \.dac-validation/, name);
    assert.equal(existsSync(join(attemptDir(run), 'workspace')), false, `${name}: no copy`);
    assert.equal(existsSync(join(attemptDir(run), 'pre-manifest.json')), false, name);
    const rec = readRec(run); assert.equal(rec.overall, 'BLOCKED'); assert.equal(rec.workspace.path, null); assert.equal(rec.workspace_outputs, null); assert.equal(rec.commands.length, 0);
    assert.equal(rec.workspace.matches_audit_result_tree, false);
  }
  // a similarly named product path is not the reserved root: it proceeds to the normal binding checks
  const { run } = await ready(); write(run.run.worktree.path, '.dac-validation-notes/a', 'x\n');
  const res = await validate(run, { result_tree: 'a'.repeat(40) });
  assert.doesNotMatch(res.reasons.join(), /reserved DAC validation root/); assert.match(res.reasons.join(), /does not reproduce audit\.result_tree/);
});

test('a review whose worktree gained the reserved root never invokes the validator commands or the reviewer', async () => {
  const { root, st, run } = await ready(); const rv = reviewRunner(); const v = validationSim();
  write(run.run.worktree.path, '.dac-validation/x', 'y\n');
  const r = await review(root, st, { runner: rv, validator: v });
  assert.notEqual(r.code, 0); assert.equal(rv.calls.length, 0); assert.equal(v.calls.length, 0);
});

test('environment evidence lists variable NAMES and overrides (never values) in the record and the reviewer summary', async () => {
  const parentEnv = { PATH: '/secret/path-value', LANG: 'en_US', OPENAI_API_KEY: 'sk-leak', NODE_OPTIONS: '--require x', NPM_TOKEN: 'tok' };
  const e = validationRunner({ platform: 'darwin', sandboxAvailable: () => true, parentEnv }).describe().environment;
  assert.deepEqual(e.inherited_allowlist_present, ['PATH', 'LANG']);
  assert.deepEqual(e.fixed_overrides, ['CI', 'HOME', 'TMPDIR', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_update_notifier']);
  assert.deepEqual(e.fixed_overrides, FIXED_ENV_KEYS);
  assert.match(e.not_inherited, /Provider, API, token and NODE_OPTIONS keys .* NOT inherited/);
  const text = JSON.stringify(e); for (const v of ['/secret/path-value', 'en_US', 'sk-leak', '--require x', 'tok"']) assert.equal(text.includes(v), false, v);
  assert.equal(JSON.stringify(environmentEvidence({})).includes('"inherited_allowlist_present":[]'), true);

  const { root, st, run } = await ready(); const rv = reviewRunner();
  const r = await review(root, st, { runner: rv, validator: validationSim(undefined, { profile: { environment: e } }) });
  assert.equal(r.code, 0, r.out);
  const rec = readRec(run);
  assert.deepEqual(rec.environment.inherited_allowlist_present, ['PATH', 'LANG']); assert.deepEqual(rec.environment.fixed_overrides, FIXED_ENV_KEYS);
  const prompt = rv.calls[0].prompt;
  for (const s of ['inherited_allowlist_present', 'npm_config_update_notifier', 'NODE_OPTIONS keys', 'NOT inherited']) assert.ok(prompt.includes(s), s);
  for (const v of ['/secret/path-value', 'sk-leak']) assert.equal(prompt.includes(v) || JSON.stringify(rec).includes(v), false, v);
});
