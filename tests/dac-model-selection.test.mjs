// dac implement/review --model: explicit, opaque, user-selected Codex model; inherited when omitted; no fallback; safe runner-failure excerpt.
// Everything is simulated (injected runners / injected spawn); no Codex binary is ever executed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeProfile, codexRunner, validateModel, safeExcerpt, MODEL_MAX } from '../adapters/shared/sdd-run/runners.mjs';
import { mainWithDeps } from '../bin/dac.mjs';
import * as H from './support/run-harness.mjs';
import { implRunner, reviewRunner, okResult, makeProject, impl, review, runs, SCAFFOLD, ok, BASE_FILES, tty } from './support/run-harness.mjs';

after(() => { rmSync(H.scratch, { recursive: true, force: true }); });
const project = () => makeProject({ files: BASE_FILES });
const okSpawn = (calls) => (bin, argv, opts) => { calls.push({ bin, argv, opts }); writeFileSync(argv[argv.indexOf('--output-last-message') + 1], JSON.stringify(okResult([]))); return { status: 0, stdout: '', stderr: '' }; };
const digestOf = (text) => /authorization digest: ([0-9a-f]+)/.exec(text)[1];

// ---- validation --------------------------------------------------------------------------------------------------------------
test('model validation: opaque safe value only; no catalog; unsafe values are refused before anything is created', async () => {
  for (const good of ['gpt-5.4', 'o3', 'vendor/model:2025-01', 'any opaque-name', 'x'.repeat(MODEL_MAX)]) assert.equal(validateModel(good), good);
  assert.equal(validateModel(undefined), undefined);
  for (const bad of ['', 'x'.repeat(MODEL_MAX + 1), 'a\nb', 'a\u0000b', 'a\u001b[31m', 'a\u007f', '--yolo', '-m', ' lead', 'trail ', 42, null]) assert.throws(() => validateModel(bad), { code: 'INPUT' }, JSON.stringify(bad));
  const root = project();
  for (const bad of ['a\nb', '-x', 'x'.repeat(MODEL_MAX + 1)]) {
    const r = await impl(root, { flags: { model: bad } }); assert.equal(r.code, 'INPUT'); assert.equal(r.terminal.calls.length, 0); assert.equal(r.runner.calls.length, 0);
  }
  const rev = await review(root, H.state(), { flags: { model: 'a\tb' } }); assert.ok(['INPUT', 'NO_RUN'].includes(rev.code));
});

test('CLI: --model is an accepted value flag on implement and review; missing/empty/option-like values are usage errors', async () => {
  const run = async (args) => { const err = []; const e = console.error; const l = console.log; console.error = (s) => err.push(String(s)); console.log = () => {}; try { return { code: await mainWithDeps(args, H.fresh('cwd'), {}, {}), err: err.join('\n') }; } finally { console.error = e; console.log = l; } };
  for (const args of [['implement', 't', '--model'], ['implement', 't', '--model', ''], ['implement', 't', '--model', '--yolo'], ['review', 't', '--model', '-x'], ['implement', 't', '--model', 'a', '--model', 'b']]) {
    const r = await run(args); assert.equal(r.code, 2, args.join(' ')); assert.match(r.err, /Unknown, repeated or incomplete option/);
  }
  const help = []; const l = console.log; console.log = (s) => help.push(String(s)); try { await mainWithDeps(['--help'], process.cwd(), {}, {}); } finally { console.log = l; }
  assert.match(help.join('\n'), /implement <task-id>[^\n]*--model <model>/); assert.match(help.join('\n'), /review <task-id>[^\n]*--model <model>/); assert.match(help.join('\n'), /account-specific/);
});

// ---- implement: selection, argv, profile, authorization --------------------------------------------------------------------------
test('implement: explicit model is previewed, in the profile and authorization, passed to the runner and persisted; inherited is stated as such', async () => {
  const root = project(); const st = H.state();
  const a = await impl(root, { st, flags: { model: 'acct-model-1' }, runner: implRunner(SCAFFOLD, ok()) });
  assert.equal(a.code, 0, a.out); assert.match(a.terminal.calls[0].text, /model:        acct-model-1 \(explicit --model/);
  assert.equal(a.runner.calls[0].model, 'acct-model-1');
  const [ra] = runs(root, st); const authz = JSON.parse(readFileSync(join(ra.dir, 'authorization.json'), 'utf8'));
  assert.deepEqual(authz.model, { selection: 'explicit', value: 'acct-model-1' }); assert.equal(authz.runner_profile.model, 'acct-model-1');
  assert.deepEqual(ra.run.runner.model, { selection: 'explicit', value: 'acct-model-1' }); assert.equal(ra.run.runner.profile.model, 'acct-model-1');

  const root2 = project(); const b = await impl(root2, {});
  assert.equal(b.code, 0, b.out); assert.match(b.terminal.calls[0].text, /model:        inherited from the Codex configuration \(no --model passed/);
  assert.equal(b.runner.calls[0].model, undefined);
  const [rb] = runs(root2, b.st); assert.deepEqual(rb.run.runner.model, { selection: 'inherited', value: null });
});

test('implement: changing, adding or removing the model changes the authorization digest and requires a new approval', async () => {
  const root = project(); const st = H.state(); const digests = [];
  for (const model of ['m-a', 'm-b', undefined]) {
    const t = tty(); const r = await impl(root, { st, terminal: t, flags: { model }, runner: implRunner(SCAFFOLD, ok()) });
    assert.equal(r.code, 0, r.out); assert.equal(t.calls.length, 1, `new approval required for ${model}`); digests.push(digestOf(t.calls[0].text));
  }
  assert.equal(new Set(digests).size, 3);
  const again = tty(); await impl(root, { st, terminal: again, flags: { model: 'm-a' }, runner: implRunner(SCAFFOLD, ok()) });
  assert.equal(again.calls.length, 0, 'the identical selection reuses its still-valid approval');
});

test('implement: a runner whose profile does not carry exactly the selected model is refused (no silent substitution)', async () => {
  const root = project();
  const sub = await impl(root, { flags: { model: 'wanted' }, runner: implRunner(SCAFFOLD, ok(), { profile: { model: 'substituted' } }) });
  assert.equal(sub.code, 'UNSAFE_PROFILE'); assert.equal(sub.terminal.calls.length, 0);
  const extra = await impl(root, { runner: implRunner(SCAFFOLD, ok(), { profile: { model: 'sneaky-default' } }) });
  assert.equal(extra.code, 'UNSAFE_PROFILE');
});

// ---- review ------------------------------------------------------------------------------------------------------------------------
test('review: explicit model is shown, passed to the runner and recorded; inherited is recorded as inherited', async () => {
  const root = project(); const i = await impl(root); assert.equal(i.code, 0, i.out);
  const a = await review(root, i.st, { flags: { model: 'rev-model' } });
  assert.equal(a.code, 0, a.out); assert.match(a.out, /model:    rev-model \(explicit --model/); assert.equal(a.runner.calls[0].model, 'rev-model');
  const [r1] = runs(root, i.st); const rec = r1.reviews[0];
  assert.deepEqual(rec.reviewer.model, { selection: 'explicit', value: 'rev-model' }); assert.equal(rec.reviewer.profile.model, 'rev-model');
  const b = await review(root, i.st); assert.equal(b.code, 0, b.out); assert.match(b.out, /model:    inherited from the Codex configuration/); assert.equal(b.runner.calls[0].model, undefined);
  const recs = runs(root, i.st)[0].reviews; assert.deepEqual(recs.at(-1).reviewer.model, { selection: 'inherited', value: null });
  const bad = await review(root, i.st, { runner: reviewRunner(() => {}, null, { profile: { model: 'other' } }), flags: { model: 'rev-model' } }); assert.equal(bad.code, 'UNSAFE_PROFILE');
});

// ---- production runner argv ----------------------------------------------------------------------------------------------------------
test('Codex runner argv: `--model VALUE` only when explicit, exactly as given, for implement and review; otherwise absent', async () => {
  for (const role of ['implement', 'review']) {
    for (const model of ['gpt-test-1', 'a b', 'yolo-model', undefined]) {
      const calls = []; const runner = codexRunner(role, { bin: 'codex-test-bin', spawn: okSpawn(calls) });
      const profile = assertSafeProfile(runner.describe({ network: false, model }), role, false, model);
      await runner.run({ cwd: '/wt', prompt: 'P', runDir: H.fresh('rd'), network: false, model });
      const { argv } = calls[0];
      if (model === undefined) { assert.ok(!argv.includes('--model')); assert.equal(profile.model, null); assert.equal(profile.model_source, 'inherited'); } else {
        assert.equal(argv.filter((a) => a === '--model').length, 1); assert.equal(argv[argv.indexOf('--model') + 1], model); assert.equal(argv[0], 'exec');
        assert.equal(profile.model, model); assert.equal(profile.model_source, 'explicit'); assert.ok(argv.every((a) => !a.startsWith('--model=')));
      }
    }
  }
  assert.throws(() => codexRunner('implement').describe({ model: '--yolo' }), { code: 'INPUT' });
  assert.throws(() => assertSafeProfile({ ...codexRunner('review').describe({}), argv: ['exec', '--yolo'] }, 'review', false), { code: 'UNSAFE_PROFILE' });
});

// ---- runner failure presentation ---------------------------------------------------------------------------------------------------
const UNSUPPORTED = 'ERROR: {"detail":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account."}\n';
test('reported scenario: unsupported model -> RUNNER_FAILED, evidence kept, bounded redacted cause and transcript path shown', async () => {
  const root = project(); const secret = 'sk-abcdefghijklmnop1234567890'; const envSecret = 'ENV-VALUE-SHOULD-NEVER-APPEAR';
  const noise = Array.from({ length: 60 }, (_, i) => `debug line ${i} ${'x'.repeat(400)}`).join('\n');
  const stderr = `${noise}\nOPENAI_API_KEY=${secret}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n\u001b[31mred\u001b[0m\u0007\n${UNSUPPORTED}`;
  const runner = codexRunner('implement', { spawn: () => ({ status: 1, stdout: 'big stdout', stderr }) });
  process.env.DAC_TEST_ENV_SECRET = envSecret;
  const r = await impl(root, { runner, flags: { model: 'gpt-5.5' } }); delete process.env.DAC_TEST_ENV_SECRET;
  assert.equal(r.code, 1); const [run] = runs(root, r.st); assert.equal(run.outcome.status, 'RUNNER_FAILED'); assert.ok(run.audit && existsSync(run.run.worktree.path));
  const transcript = join(run.dir, 'implement-transcript.txt'); assert.ok(existsSync(transcript));
  for (const text of [r.out, run.outcome.runner_error]) {
    assert.match(text, /codex exited with 1/); assert.match(text, /model is not supported when using Codex with a ChatGPT account/); assert.match(text, /explicitly via --model/);
    assert.ok(text.includes(transcript), 'transcript path is shown'); assert.ok(!text.includes(secret)); assert.ok(!/Bearer abcdefgh/.test(text)); assert.ok(!text.includes(envSecret)); assert.ok(!/[\u0000-\u0009\u000b-\u001f\u001b]/.test(text)); assert.ok(!text.includes('debug line 0 '));
  }
  assert.ok(run.outcome.runner_error.length < 3000, 'bounded');
  assert.match(readFileSync(transcript, 'utf8'), /debug line 0/, 'the full stderr stays only in the retained transcript');
  assert.equal(JSON.parse(readFileSync(join(run.dir, 'authorization.json'), 'utf8')).model.value, 'gpt-5.5');
});

test('runner failure with empty stderr, a spawn error, a signal, and inherited model all give a useful generic cause', async () => {
  const dir = H.fresh('rf'); const mk = (spawn, d) => codexRunner('implement', { spawn }).run({ cwd: '/wt', prompt: 'p', runDir: d, network: false });
  await assert.rejects(mk(() => ({ status: 2, stdout: '', stderr: '' }), dir), (e) => e.code === 'RUNNER' && /codex exited with 2/.test(e.message) && /nothing on stderr/.test(e.message) && /inherited from the Codex configuration/.test(e.message) && e.message.includes(join(dir, 'implement-transcript.txt')));
  await assert.rejects(mk(() => ({ status: null, error: Object.assign(new Error('spawn codex ENOENT token=abc12345secret'), { code: 'ENOENT' }) }), H.fresh('rf')), (e) => /could not run \(ENOENT\)/.test(e.message) && /spawn codex ENOENT/.test(e.message) && !/abc12345secret/.test(e.message));
  await assert.rejects(mk(() => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }), H.fresh('rf')), /terminated by signal SIGTERM/);
});

test('safeExcerpt: caps lines and bytes, strips control chars, redacts common secret forms, prefers causal lines', () => {
  const secrets = ['sk-proj-abcdefgh12345678', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'github_pat_abcdefghijklmnopqrstuv', 'xoxb-1234567890-abcdef', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcDEF123', 'hunter2hunter2', 'abcdef0123456789abcdef0123456789abcdef01'];
  const text = [`password=${secrets[6]}`, `url https://user:${secrets[6]}@host/x`, ...secrets.filter((_, i) => i !== 6), '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkq\n-----END PRIVATE KEY-----', 'ERROR something failed \u0000\u0008'].join('\n');
  const out = safeExcerpt(text); for (const s of secrets) assert.ok(!out.includes(s), s); assert.ok(!out.includes('MIIBVQ')); assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(out)); assert.match(out, /something failed/);
  const many = safeExcerpt(Array.from({ length: 100 }, (_, i) => `error number ${i}`).join('\n')); assert.ok(many.split('\n').length <= 8); assert.match(many, /error number 99/);
  assert.ok(Buffer.byteLength(safeExcerpt('error ' + 'é'.repeat(5000), { maxLineChars: 99999 })) <= 1024 + 3);
  assert.equal(safeExcerpt(''), ''); assert.equal(safeExcerpt(undefined), '');
});

test('review runner failure surfaces the same bounded cause in the review record and output', async () => {
  const root = project(); const i = await impl(root);
  const runner = codexRunner('review', { spawn: () => ({ status: 1, stdout: '', stderr: UNSUPPORTED }) });
  const r = await review(root, i.st, { runner, flags: { model: 'gpt-5.5' } });
  assert.equal(r.code, 1); assert.match(r.out, /model is not supported/); assert.match(r.out, /review-transcript\.txt/);
  const rec = runs(root, i.st)[0].reviews.at(-1); assert.equal(rec.verdict, 'INVALID_RESULT'); assert.match(rec.result_errors[0], /model is not supported/); assert.equal(rec.reviewer.model.value, 'gpt-5.5');
});
