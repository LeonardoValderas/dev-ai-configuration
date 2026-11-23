// Structured Codex output for dac implement/review: --output-schema derived from the canonical result schema, canonical validation
// unchanged (a missing schema_version stays INVALID_RESULT, nothing is repaired), exact field survival, and retrying a failed review
// on the same run without touching the immutable evidence. Everything is simulated (injected spawn); no Codex binary is executed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexRunner, parseResult, deriveProviderResultSchema, assertSafeProfile } from '../adapters/shared/sdd-run/runners.mjs';
import { contractErrors, buildReviewPrompt } from '../adapters/shared/sdd-run/context.mjs';
import * as H from './support/run-harness.mjs';
import { okResult, makeProject, impl, review, runs, BASE_FILES } from './support/run-harness.mjs';

after(() => { rmSync(H.scratch, { recursive: true, force: true }); });
const RICH = () => okResult(['a.js', 'b/c.js'], { execution_status: 'PARTIAL', validation_result: 'FAIL', evidence: [{ description: 'd1', command: 'node --test', output_summary: 'ok' }, { description: 'd2' }], warnings: ['w "quoted" é'], unresolved_blockers: ['blk'] });
const spawnWriting = (calls, text) => (bin, argv, opts) => { calls.push({ bin, argv, opts }); writeFileSync(argv[argv.indexOf('--output-last-message') + 1], typeof text === 'function' ? text() : text); return { status: 0, stdout: '', stderr: '' }; };

test('canonical: a complete result is accepted; a missing schema_version is rejected and never repaired', () => {
  assert.deepEqual(contractErrors('result', okResult([])), []);
  assert.deepEqual(contractErrors('result', RICH()), []);
  const { schema_version, ...noVersion } = okResult([]);
  assert.ok(contractErrors('result', noVersion).some((e) => /schema_version/.test(e)));
  assert.ok(contractErrors('result', { ...okResult([]), schema_version: 'one' }).length);
  // extraction never injects or fixes anything
  const parsed = parseResult(JSON.stringify(noVersion));
  assert.equal('schema_version' in parsed, false); assert.deepEqual(parsed, noVersion);
});

test('extraction preserves every canonical field exactly (plain and fenced), including unknown fields so validation can reject them', async () => {
  const rich = RICH();
  assert.deepEqual(parseResult(JSON.stringify(rich)), rich);
  assert.deepEqual(parseResult('```json\n' + JSON.stringify(rich, null, 2) + '\n```'), rich);
  for (const role of ['implement', 'review']) {
    const out = await codexRunner(role, { spawn: spawnWriting([], JSON.stringify(rich)) }).run({ cwd: '/wt', prompt: 'p', runDir: H.fresh('so'), network: false });
    assert.deepEqual(out.result, rich);
  }
  const extra = { ...okResult([]), surprise: 1 };
  assert.deepEqual(parseResult(JSON.stringify(extra)), extra); assert.ok(contractErrors('result', extra).length, 'unknown fields stay a contract error');
});

test('provider schema is derived deterministically from the canonical schema: self-contained, same fields, no second contract', () => {
  const a = deriveProviderResultSchema(); const b = deriveProviderResultSchema();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const text = JSON.stringify(a); assert.doesNotMatch(text, /\$ref|\$id|\$schema|\$defs/);
  const canonical = JSON.parse(readFileSync(new URL('../standards/schemas/result.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(a.required, canonical.required); assert.deepEqual(Object.keys(a.properties), Object.keys(canonical.properties));
  assert.equal(a.additionalProperties, false); assert.ok(a.required.includes('schema_version'));
  assert.deepEqual(a.properties.schema_version, { type: 'string', pattern: '^[0-9]+\\.[0-9]+$' });
  assert.deepEqual(a.properties.execution_status.enum, canonical.properties.execution_status.enum);
  assert.deepEqual(a.properties.validation_result.enum, canonical.properties.validation_result.enum);
  assert.deepEqual(a.properties.evidence.items.required, ['description', 'command', 'output_summary']); // strict-mode narrowing only
  // everything the provider schema admits for evidence is canonical-valid
  assert.deepEqual(contractErrors('result', okResult([], { evidence: [{ description: 'x', command: '', output_summary: '' }] })), []);
});

test('argv contract: implement and review pass --output-schema <file> plus --output-last-message; the schema file is the derived schema; safety flags unchanged', async () => {
  for (const [role, network] of [['implement', false], ['implement', true], ['review', false]]) {
    const calls = []; const dir = H.fresh('argv'); let schemaOnDisk;
    const spawn = (bin, argv, opts) => { schemaOnDisk = readFileSync(argv[argv.indexOf('--output-schema') + 1], 'utf8'); return spawnWriting(calls, JSON.stringify(okResult([])))(bin, argv, opts); };
    const runner = codexRunner(role, { bin: 'codex-test-bin', spawn });
    const profile = assertSafeProfile(runner.describe({ network, model: 'm-1' }), role, role === 'implement' ? network : false, 'm-1');
    assert.ok(profile.argv.includes('--output-schema') && profile.argv.includes('<schema-file>'));
    const out = await runner.run({ cwd: '/wt', prompt: 'P', runDir: dir, network, model: 'm-1' });
    assert.equal(out.result.schema_version, '1.0');
    const { argv, opts } = calls[0]; const i = argv.indexOf('--output-schema');
    assert.ok(i > 0 && argv[i + 1] === join(dir, `${role}-output-schema.json`) && argv[i + 1].endsWith('.json'));
    assert.equal(argv[argv.indexOf('--output-last-message') + 1], join(dir, `${role}-last-message.txt`)); assert.equal(argv.at(-1), '-');
    assert.deepEqual(JSON.parse(schemaOnDisk), deriveProviderResultSchema());
    assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'm-1']);
    const line = argv.join(' '); assert.ok(argv.includes(role === 'implement' ? 'workspace-write' : 'read-only')); assert.ok(line.includes('mcp_servers={}') && line.includes(`approval_policy="${role === 'implement' ? 'on-request' : 'never'}"`));
    assert.equal(line.includes(`network_access=${network}`), role === 'implement'); assert.ok(!/bypass|yolo|danger|full-auto/i.test(line)); assert.equal(opts.shell, false);
  }
});

// Provider compatibility invariant for the constructions present in the result contract: every const/enum node has an explicit type,
// const is not used, every object lists all its properties as required with additionalProperties false.
const compatErrors = (node, at = '') => {
  if (Array.isArray(node)) return node.flatMap((n, i) => compatErrors(n, `${at}/${i}`));
  if (!node || typeof node !== 'object') return [];
  const errs = [];
  if (('const' in node || 'enum' in node) && node.type === undefined) errs.push(`${at}: schema must specify a type`);
  if ('const' in node) errs.push(`${at}: const is not provider-compatible`);
  if (node.type === 'object') {
    const keys = Object.keys(node.properties ?? {});
    if (JSON.stringify([...(node.required ?? [])].sort()) !== JSON.stringify([...keys].sort())) errs.push(`${at}: required must list every property`);
    if (node.additionalProperties !== false) errs.push(`${at}: additionalProperties must be false`);
  }
  for (const [k, v] of Object.entries(node)) errs.push(...compatErrors(v, `${at}/${k}`));
  return errs;
};
// The previous projection (a reconstructed minimal reproduction, not a captured artifact): refs inlined, optional made required, but const/enum left untyped.
const priorProjection = () => {
  const s = JSON.parse(JSON.stringify(deriveProviderResultSchema()));
  s.properties.kind = { const: 'result' }; delete s.properties.execution_status.type; delete s.properties.validation_result.type;
  return s;
};

test('provider schema: const/enum nodes get explicit types and exact canonical values', () => {
  const s = deriveProviderResultSchema();
  assert.deepEqual(s.properties.kind, { type: 'string', enum: ['result'] });
  assert.deepEqual(s.properties.execution_status, { type: 'string', enum: ['COMPLETE', 'PARTIAL', 'BLOCKED'] });
  assert.deepEqual(s.properties.validation_result, { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED'] });
  assert.deepEqual(compatErrors(s), []);
});

test('provider schema: required fields and nested object/array shapes stay provider-compatible', () => {
  const s = deriveProviderResultSchema();
  assert.deepEqual(s.required, ['schema_version', 'kind', 'execution_status', 'validation_result', 'files_changed', 'evidence', 'warnings', 'unresolved_blockers']);
  for (const k of ['files_changed', 'warnings', 'unresolved_blockers']) assert.deepEqual([s.properties[k].type, s.properties[k].items.type], ['array', 'string']);
  assert.equal(s.properties.evidence.type, 'array'); assert.equal(s.properties.evidence.items.type, 'object');
  assert.equal(s.properties.evidence.items.additionalProperties, false);
  assert.deepEqual(s.properties.evidence.items.properties.description, { type: 'string', minLength: 1 });
});

test('the prior projection fails the new compatibility invariant (the real Codex error)', () => {
  const errs = compatErrors(priorProjection());
  assert.ok(errs.some((e) => e.startsWith('/properties/kind') && /must specify a type/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => e.startsWith('/properties/execution_status')));
});

test('provider schema derivation fails closed on empty or mixed-type const/enum values (never a type array)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dac-schema-'));
  try {
    writeFileSync(join(dir, 'common.schema.json'), '{}');
    const derive = (props) => { writeFileSync(join(dir, 'result.schema.json'), JSON.stringify({ type: 'object', properties: props })); return deriveProviderResultSchema(dir); };
    assert.deepEqual(derive({ a: { const: 'x' }, b: { enum: ['x', 'y'] } }).properties, { a: { type: 'string', enum: ['x'] }, b: { type: 'string', enum: ['x', 'y'] } });
    for (const bad of [{ enum: [] }, { enum: ['x', 1] }, { enum: ['x', null] }]) {
      assert.throws(() => derive({ a: bad }), (e) => e.code === 'RUNNER' && /single provider type/.test(e.message), JSON.stringify(bad));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canonical validation stays authoritative: wrong kind and missing required fields are rejected, nothing repaired', () => {
  assert.ok(contractErrors('result', { ...okResult([]), kind: 'other' }).length);
  for (const f of deriveProviderResultSchema().required) {
    const { [f]: _omit, ...rest } = okResult([]);
    assert.ok(contractErrors('result', rest).length, `missing ${f} must be rejected`);
    assert.equal(f in parseResult(JSON.stringify(rest)), false);
  }
});

test('the review prompt names every required result field, including schema_version', async () => {
  const root = makeProject({ files: BASE_FILES }); const r = await impl(root); assert.equal(r.code, 0, r.out);
  const rv = H.reviewRunner(); await review(root, r.st, { runner: rv });
  assert.match(rv.calls[0].prompt, /"schema_version":"1\.0","kind":"result"/); assert.match(rv.calls[0].prompt, /schema_version and kind/);
  assert.equal(typeof buildReviewPrompt, 'function');
});

test('retry: a review that failed with INVALID_RESULT (no schema_version) is re-reviewed on the SAME run; run, authorization, audit, diff and worktree are untouched', async () => {
  const root = makeProject({ files: BASE_FILES }); const r = await impl(root); assert.equal(r.code, 0, r.out);
  const [run] = runs(root, r.st); const evidence = ['run.json', 'audit.json', 'diff.patch', 'authorization.json', 'outcome.json'].filter((f) => existsSync(join(run.dir, f)));
  assert.ok(evidence.includes('run.json') && evidence.includes('audit.json') && evidence.includes('diff.patch') && evidence.includes('authorization.json'));
  const snap = () => Object.fromEntries(evidence.map((f) => [f, readFileSync(join(run.dir, f), 'utf8')]));
  const before = snap();

  const { schema_version, ...broken } = okResult([]);
  const calls1 = []; const first = await review(root, r.st, { runner: codexRunner('review', { spawn: spawnWriting(calls1, JSON.stringify(broken)) }) });
  assert.equal(first.code, 1, first.out); assert.match(first.out, /INVALID_RESULT/);
  const failed = runs(root, r.st)[0].reviews; assert.equal(failed.length, 1); assert.equal(failed[0].verdict, 'INVALID_RESULT'); assert.ok(failed[0].result_errors.some((e) => /schema_version/.test(e)));
  assert.equal(failed[0].result, null); assert.equal(failed[0].audit_hash, run.audit.audit_hash);
  const failedFile = readdirSync(join(run.dir, 'reviews'))[0]; const failedText = readFileSync(join(run.dir, 'reviews', failedFile), 'utf8');

  const calls2 = []; const second = await review(root, r.st, { runner: codexRunner('review', { spawn: spawnWriting(calls2, JSON.stringify(okResult([]))) }) });
  assert.equal(second.code, 0, second.out); assert.match(second.out, /: PASS/);
  const all = runs(root, r.st)[0].reviews; assert.equal(all.length, 2); assert.deepEqual(all.map((x) => x.verdict).sort(), ['INVALID_RESULT', 'PASS']);
  const pass = all.find((x) => x.verdict === 'PASS');
  for (const k of ['run_id', 'audit_hash', 'content_hash', 'diff_sha256', 'result_tree', 'base_commit']) assert.equal(pass[k], failed[0][k], k);
  assert.equal(pass.binding_rechecked_after_review, 'equal'); assert.equal(pass.reviewer.profile.sandbox, 'read-only'); assert.equal(pass.reviewer.profile.mcp, 'none');
  assert.deepEqual(snap(), before, 'immutable run evidence is untouched'); assert.equal(readFileSync(join(run.dir, 'reviews', failedFile), 'utf8'), failedText, 'the failed review is preserved');
  // retry files are separate evidence, never overwritten
  const files = readdirSync(run.dir); for (const f of ['review-last-message.txt', 'review-last-message-2.txt', 'review-output-schema.json', 'review-output-schema-2.json', 'review-transcript.txt', 'review-transcript-2.txt']) assert.ok(files.includes(f), f);
  assert.equal(JSON.parse(readFileSync(join(run.dir, 'review-last-message.txt'), 'utf8')).schema_version, undefined);
  for (const c of [calls1, calls2]) assert.ok(c[0].argv.includes('--output-schema'));
});
