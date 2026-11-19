// `dac review <task-id>`: an independent, read-only code-reviewer session bound to the exact audited content of one
// implementation run. The implementer can never approve; the binding is re-checked after the review; nothing is cleaned up,
// merged or published.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunError, metaFingerprint, mainFingerprint, sha256 } from './git.mjs';
import { loadContext, buildContract, buildReviewPrompt, contractErrors, digestOf } from './context.mjs';
import { auditWorktree } from './audit.mjs';
import { assertSafeProfile, codexRunner, validateModel, modelSelection, modelLabel } from './runners.mjs';
import { stateRoot, taskDir, assertStateOutside, writeOnce, withLock, listRuns, fileSha, evidenceFingerprint } from './store.mjs';
import { validationRunner, assertSafeValidationProfile, runIndependentValidation } from './validation.mjs';
import { collectEvidence } from './evidence.mjs';
import { resolveProjectId } from './implement.mjs';

export async function reviewTask({ root, taskId, flags = {}, deps = {} }) {
  const log = deps.log ?? console.log;
  const clock = deps.clock ?? Date.now; const random = deps.random ?? ((n) => randomBytes(n).toString('hex'));
  const state = stateRoot(deps);
  assertStateOutside(state, root);
  const pid = resolveProjectId(root, flags.project);
  const dir = taskDir(state, root, pid, taskId);
  const all = listRuns(dir);
  if (!all.length) throw new RunError('NO_RUN', `no implementation run exists for task "${taskId}"; run dac implement ${taskId} first`);
  const ready = all.filter((r) => r.outcome?.status === 'READY_FOR_REVIEW');
  let sel;
  if (flags.run !== undefined) {
    sel = all.find((r) => r.run_id === flags.run);
    if (!sel) throw new RunError('NO_RUN', `run "${flags.run}" does not exist for task "${taskId}" (runs: ${all.map((r) => r.run_id).join(', ')})`);
    if (sel.outcome?.status !== 'READY_FOR_REVIEW') throw new RunError('NOT_REVIEWABLE', `run ${sel.run_id} is ${sel.outcome?.status ?? 'incomplete'}, not READY_FOR_REVIEW; blocked or failed runs are never reviewed`);
  } else if (ready.length === 1) sel = ready[0];
  else if (ready.length === 0) throw new RunError('NOT_REVIEWABLE', `no run of task "${taskId}" is READY_FOR_REVIEW (${all.map((r) => `${r.run_id}: ${r.outcome?.status ?? 'incomplete'}`).join(', ')})`);
  else throw new RunError('RUN_AMBIGUOUS', `several runs of task "${taskId}" are ready for review (${ready.map((r) => r.run_id).join(', ')}); choose one with --run <run-id>`);

  const { run, audit, outcome } = sel;
  // ---- integrity of the immutable evidence ----
  const bad = (why) => { throw new RunError('EVIDENCE', `evidence for run ${sel.run_id} is not intact: ${why}`); };
  if (fileSha(join(sel.dir, 'run.json')) !== outcome.run_sha256) bad('run.json changed');
  if (fileSha(join(sel.dir, 'audit.json')) !== outcome.audit_file_sha256 || audit.audit_hash !== outcome.audit_hash) bad('audit.json changed');
  if (audit.status !== 'PASS') bad('the audit did not pass');
  const diff = readFileSync(join(sel.dir, 'diff.patch'));
  if (sha256(diff) !== audit.diff_sha256 || sha256(diff) !== outcome.diff_sha256) bad('diff.patch changed');
  // the SDD context must still be the one the run was authorized against
  const ctx = loadContext(root, pid, taskId);
  for (const k of Object.keys(run.artifacts)) if (JSON.stringify(ctx.artifacts[k]) !== JSON.stringify(run.artifacts[k])) throw new RunError('DRIFT', `the SDD context changed since the run (${k}); the review is refused`);
  const contract = buildContract(ctx);
  if (digestOf(contract) !== run.contract_sha256) throw new RunError('DRIFT', 'the task contract no longer matches the one the run was authorized with');

  const runner = deps.reviewRunner ?? codexRunner('review');
  if (runner.role !== 'review') throw new RunError('UNSAFE_PROFILE', 'the review runner must have role "review"; an implementation runner can never review');
  if (runner.id === run.runner.id) throw new RunError('NOT_INDEPENDENT', 'the reviewer must be a different runner/session identity than the implementer');
  const model = validateModel(flags.model); // opaque user-selected value; never replaced, normalized or defaulted
  const profile = assertSafeProfile(runner.describe({ network: false, model }), 'review', false, model);
  // dedicated independent-validation runner (injectable): a different identity than the implementer and the reviewer
  const validator = deps.validationRunner ?? validationRunner();
  assertSafeValidationProfile(validator, run.runner.id, runner.id);

  return withLock(dir, async () => {
    const recheck = () => auditWorktree({ root, run, contract, pre: run.pre, environment: false, claimedFiles: null });
    const immutable = () => Object.fromEntries(['run.json', 'audit.json', 'diff.patch', 'authorization.json', 'outcome.json'].map((f) => [f, fileSha(join(sel.dir, f))]));
    const capture = () => { const a = recheck(); return { content: a.content_hash, status: a.body.status, meta: metaFingerprint(root), main: mainFingerprint(root), evidence: evidenceFingerprint(state, root, dir, sel.run_id), files: immutable() }; };
    const before = capture();
    if (before.content !== audit.content_hash || before.status !== 'PASS') throw new RunError('EVIDENCE', 'the worktree no longer matches the audited content; the review is refused (the worktree and evidence are preserved)');
    const snap = { meta: before.meta, main: before.main };
    const driftOf = () => {
      const n = capture(); const d = [];
      if (n.content !== audit.content_hash || n.status !== 'PASS') d.push('audited worktree content changed');
      if (n.meta !== before.meta) d.push('Git metadata changed');
      if (n.main !== before.main) d.push('the original project changed');
      if (n.evidence !== before.evidence) d.push('approval records or evidence of other runs changed');
      for (const f of Object.keys(before.files)) if (n.files[f] !== before.files[f]) d.push(`${f} changed`);
      return d;
    };
    const reviewId = `v-${new Date(clock()).toISOString().replace(/[-:T.Z]/g, '').slice(0, 17)}-${random(3)}`;

    // ---- independent validation: exactly the authorized commands, BEFORE the reviewer; any problem blocks the review ----
    log(`dac review: independent validation of ${(contract.validation_commands ?? []).length} authorized command(s) by ${validator.id} (separate from implementer and reviewer)`);
    const validation = await runIndependentValidation({ root, run, contract, audit, runDir: sel.dir, runner: validator, clock, checkBinding: () => { try { return driftOf(); } catch (e) { return [`binding check failed: ${e.message}`]; } } });
    if (!validation.ok) {
      const record = {
        kind: 'dac-review', schema: 1, review_id: reviewId, run_id: sel.run_id, task_id: taskId, project_id: pid, verdict: 'BLOCKED', reviewer_invoked: false,
        audit_hash: audit.audit_hash, content_hash: audit.content_hash, diff_sha256: audit.diff_sha256, result_tree: audit.result_tree, base_commit: run.base_commit,
        binding_rechecked_after_review: 'not-run', reviewer: { id: runner.id, role: 'review', model: modelSelection(model), session: null, profile }, implementer: { id: run.runner.id, run_id: sel.run_id },
        validation: { attempt: validation.attempt, record_file: validation.recordFile, record_sha256: validation.recordSha, overall: 'BLOCKED' },
        result_errors: validation.reasons.map((x) => `independent validation: ${x}`), result: null, reviewed_at: new Date(clock()).toISOString(),
      };
      writeOnce(join(sel.dir, 'reviews', `${reviewId}.json`), record);
      log(`review ${reviewId}: BLOCKED (independent validation did not pass; the reviewer was NOT invoked)`);
      for (const x of validation.reasons) log(`  - ${x}`);
      log(`  full validation record: ${validation.recordFile}`);
      log('Evidence and worktree are preserved; nothing was committed, merged, published or cleaned up.');
      return 1;
    }
    const evidence = collectEvidence({ run, audit, contract, runDir: sel.dir, reviewerProfile: profile, validation: { evidence_class: 'independent validation evidence (executed by dac against the exact audited content)', ...validation.summary } });
    const prompt = buildReviewPrompt(ctx, contract, run, audit, diff, evidence);
    log(`dac review: task ${taskId}, run ${sel.run_id}\n  bound to audit hash ${audit.audit_hash}\n  diff sha256 ${audit.diff_sha256} (${audit.totals.files} file(s))\n  reviewer: ${runner.id} (read-only; separate from implementer ${run.runner.id})\n  model:    ${modelLabel(model)}`);
    let provider = null; let failure = null;
    try { provider = await runner.run({ cwd: run.worktree.path, prompt, contract, runDir: sel.dir, network: false, model, profile, diff, audit }); } catch (e) { failure = e; }
    const result = provider?.result ?? null;
    const errors = result ? contractErrors('result', result) : [failure ? `reviewer failed: ${failure.message}` : 'the reviewer returned no result'];
    if (!errors.length && result.files_changed.length) errors.push('a read-only reviewer reported changed files');

    // ---- the binding must still hold after the review ----
    const after = recheck();
    const stillBound = after.content_hash === audit.content_hash && after.body.status === 'PASS' && metaFingerprint(root) === snap.meta && mainFingerprint(root) === snap.main;
    let verdict;
    if (!stillBound) verdict = 'INVALIDATED';
    else if (errors.length) verdict = 'INVALID_RESULT';
    else verdict = result.execution_status === 'COMPLETE' && result.validation_result === 'PASS' && result.unresolved_blockers.length === 0 ? 'PASS' : result.validation_result === 'BLOCKED' || result.execution_status === 'BLOCKED' ? 'BLOCKED' : 'FAIL';
    const record = {
      kind: 'dac-review', schema: 1, review_id: reviewId, run_id: sel.run_id, task_id: taskId, project_id: pid, verdict, reviewer_invoked: true,
      audit_hash: audit.audit_hash, content_hash: audit.content_hash, diff_sha256: audit.diff_sha256, result_tree: audit.result_tree, base_commit: run.base_commit,
      binding_rechecked_after_review: stillBound ? 'equal' : 'CHANGED', reviewer: { id: runner.id, role: 'review', model: modelSelection(model), session: `review-${random(8)}`, profile }, implementer: { id: run.runner.id, run_id: sel.run_id },
      validation: { attempt: validation.attempt, record_file: validation.recordFile, record_sha256: validation.recordSha, overall: 'PASS' },
      result_errors: errors, result: errors.length ? null : result, reviewed_at: new Date(clock()).toISOString(),
    };
    writeOnce(join(sel.dir, 'reviews', `${reviewId}.json`), record);
    log(`review ${reviewId}: ${verdict}${stillBound ? '' : ' (the audited content, Git state or original project changed during the review)'}`);
    if (errors.length) log(`  ${errors[0]}`);
    if (result && !errors.length) for (const w of [...result.warnings, ...result.unresolved_blockers]) log(`  - ${w}`);
    log('Evidence and worktree are preserved; nothing was committed, merged, published or cleaned up. Integrating the branch is your decision.');
    return verdict === 'PASS' ? 0 : 1;
  });
}
