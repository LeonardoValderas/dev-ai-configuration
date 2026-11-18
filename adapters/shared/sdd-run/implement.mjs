// `dac implement <task-id>`: verified persisted task -> exact trusted-terminal authorization -> isolated branch/worktree ->
// injectable implementation runner -> blocking audit -> retained evidence. Never commits (except the explicitly reviewed
// baseline of an unborn repository), merges, publishes or cleans anything.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { assertTerminal, confirmationPhrase, openTrustedTerminal, TTL_SECONDS, effectiveConfirmTimeoutMs, CONFIRM_TIMEOUT_SECONDS } from '../sdd-writer/authorization.mjs';
import { ID_RE } from '../sdd-writer/artifacts.mjs';
import { RunError, git, repoInfo, dirtyEntries, planBaseline, applyBaseline, createWorktree, mainFingerprint, metaFingerprint, worktreeMetaFingerprint, sha256, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_CHANGED_FILES } from './git.mjs';
import { loadContext, buildContract, buildPrompt, listSddProjects, contractErrors, digestOf, PROTECTED_DIRS, PROTECTED_FILES } from './context.mjs';
import { auditWorktree } from './audit.mjs';
import { assertSafeProfile, codexRunner, validateModel, modelSelection, modelLabel } from './runners.mjs';
import { stateRoot, taskDir, assertStateOutside, writeOnce, readJson, withLock, listRuns, evidenceFingerprint } from './store.mjs';

export function resolveProjectId(root, explicit) {
  const known = listSddProjects(root);
  if (explicit !== undefined) {
    if (!ID_RE.test(explicit)) throw new RunError('INPUT', '--project must be an SDD project id (lowercase kebab-case)');
    if (!known.includes(explicit)) throw new RunError('PROJECT', `no persisted SDD project "${explicit}" (found: ${known.join(', ') || 'none'})`);
    return explicit;
  }
  if (known.length === 1) return known[0];
  if (known.length === 0) throw new RunError('PROJECT', 'no persisted SDD project.json found; persist Plan/Tasks through the SDD handoff (dac sdd apply) first');
  throw new RunError('PROJECT_AMBIGUOUS', `several SDD projects are persisted (${known.join(', ')}); choose one with --project <id>`);
}

const targetIdentity = (root) => { const st = statSync(root, { bigint: true }); return { realpath: root, device: st.dev.toString(), inode: st.ino.toString() }; };

// A dependency is satisfied only by a run of that task that passed audit AND an independent review (PASS), AND whose exact
// reviewed content is present in the project's current HEAD (the human integrated it). Content-based: any merge style works.
function dependencyState(root, head, dir, depId, pid) {
  const depDir = join(dir, '..', depId);
  const runs = listRuns(depDir).filter((r) => r.outcome?.status === 'READY_FOR_REVIEW' && r.run?.project_id === pid);
  if (!head) return { task_id: depId, ok: false, reason: 'the repository has no commits, so the dependency cannot be integrated yet' };
  let lastReason = 'no reviewed run of this task exists (run dac implement and dac review for it first)';
  for (const r of [...runs].reverse()) {
    const rev = [...r.reviews].reverse().find((x) => x.verdict === 'PASS' && x.audit_hash === r.audit?.audit_hash);
    if (!rev) { lastReason = `run ${r.run_id} has no passing independent review`; continue; }
    const missing = (r.audit.changes ?? []).filter((c) => {
      const buf = git(root, ['cat-file', 'blob', `${head}:${c.path}`], { buffer: true, allowFail: true });
      return c.status === 'deleted' ? buf !== null : buf === null || sha256(buf) !== c.sha256;
    });
    if (missing.length) { lastReason = `run ${r.run_id} is reviewed but not integrated in HEAD (${missing.length} file(s) differ, e.g. ${missing[0].path}); merge or commit it yourself first`; continue; }
    return { task_id: depId, ok: true, run_id: r.run_id, review_id: rev.review_id };
  }
  return { task_id: depId, ok: false, reason: lastReason };
}

function prepare({ root, pid, taskId, flags, state, deps }) {
  const ctx = loadContext(root, pid, taskId);
  const contract = buildContract(ctx);
  const prompt = buildPrompt(ctx, contract);
  const info = repoInfo(root);
  const dir = taskDir(state, root, pid, taskId);
  const dirty = info.unborn ? [] : dirtyEntries(root);
  if (dirty.length && !flags.preserveDirty) throw new RunError('DIRTY', `the project has ${dirty.length} uncommitted change(s) (e.g. ${dirty[0].path}). dac never stashes, resets or hides changes: they stay untouched and are NOT part of the worktree (it starts from HEAD). Re-run with --preserve-dirty to acknowledge, or commit them first.`);
  const baseline = info.unborn ? planBaseline(root) : null;
  const dependencies = ctx.deps.map((d) => dependencyState(root, info.head, dir, d, pid));
  const unmet = dependencies.filter((d) => !d.ok);
  if (unmet.length) throw new RunError('DEPENDENCY', `unmet dependencies: ${unmet.map((d) => `${d.task_id}: ${d.reason}`).join('; ')}`);
  const runner = deps.implementRunner ?? codexRunner('implement');
  if (runner.role !== 'implement') throw new RunError('UNSAFE_PROFILE', 'the implementation runner must have role "implement"');
  const network = ctx.task.needs_network === true;
  const model = validateModel(flags.model); // opaque user-selected value; never replaced, normalized or defaulted
  const profile = assertSafeProfile(runner.describe({ network, model }), 'implement', network, model);
  const authz = {
    kind: 'dac-implement-authorization', schema: 1, project_id: pid, task_id: taskId, target: targetIdentity(root),
    artifacts: ctx.artifacts, task: ctx.task, dependencies: dependencies.map(({ task_id, run_id, review_id }) => ({ task_id, run_id, review_id })),
    base: info.unborn ? { unborn: true, branch: info.headRef, baseline_digest: baseline.digest, baseline_files: baseline.files.length } : { commit: info.head, ref: info.headRef },
    dirty_policy: info.unborn ? 'unborn' : dirty.length ? 'preserve-untouched' : 'clean',
    worktree: { parent: dir, branch_prefix: `dac/${pid}/${taskId}/` },
    scope: { allowed_paths: contract.allowed_paths, prohibited_paths: contract.prohibited_paths, protected: [...PROTECTED_DIRS, ...PROTECTED_FILES], exact_path_only: ['manifests, lockfiles, CI and environment files', 'deletions', 'mode changes', 'new executables'], ceilings: { files: MAX_CHANGED_FILES, file_bytes: MAX_FILE_BYTES, total_bytes: MAX_TOTAL_BYTES } },
    validation_commands: contract.validation_commands, network: { requested_by_task: network, authorized_if_approved: network },
    prompt_sha256: sha256(prompt), contract_sha256: digestOf(contract), model: modelSelection(model), runner_profile: profile,
  };
  return { ctx, contract, prompt, info, dir, dirty, baseline, dependencies, runner, network, model, profile, authz, digest: digestOf(authz) };
}

const summary = (p, root) => {
  const a = p.authz; const L = [];
  L.push('dac implement: pre-implementation authorization requested', `  task:         ${a.task_id} - ${p.ctx.task.title}`, `  objective:    ${p.ctx.doc.objective}`,
    `  project:      ${a.project_id}    owner: ${p.ctx.owner}    change type: ${p.ctx.task.change_type}`, `  target:       ${root} (device ${a.target.device}, inode ${a.target.inode})`,
    `  base:         ${a.base.unborn ? `UNBORN repository: a reviewed baseline commit of ${a.base.baseline_files} file(s) will be created first (digest ${a.base.baseline_digest.slice(0, 12)})` : `${a.base.commit.slice(0, 12)} (${a.base.ref ?? 'detached'})`}`,
    `  working tree: ${a.dirty_policy === 'preserve-untouched' ? `${p.dirty.length} uncommitted change(s) are PRESERVED untouched and are NOT part of the worktree` : a.dirty_policy}`,
    `  worktree:     a new isolated worktree under ${a.worktree.parent}/<run>/worktree, branch ${a.worktree.branch_prefix}<run>`,
    `  allowed:      ${a.scope.allowed_paths.join(', ')}`, `  prohibited:   ${a.scope.prohibited_paths.join(', ')}`, `  protected:    ${a.scope.protected.join(', ')} (never writable)`,
    `  exact only:   ${a.scope.exact_path_only.join('; ')} must be listed by exact path in the task`,
    `  ceilings:     ${a.scope.ceilings.files} files, ${a.scope.ceilings.file_bytes} bytes/file, ${a.scope.ceilings.total_bytes} bytes total`,
    `  validation:   ${a.validation_commands.length ? a.validation_commands.join(' | ') : '(none declared)'}`,
    `  network:      ${a.network.authorized_if_approved ? 'ENABLED (the task declares dependency/network needs)' : 'disabled'}`,
    `  dependencies: ${a.dependencies.length ? a.dependencies.map((d) => `${d.task_id} (run ${d.run_id}, review ${d.review_id})`).join(', ') : 'none'}`,
    `  runner:       ${a.runner_profile.id} sandbox=${a.runner_profile.sandbox} approval=${a.runner_profile.approval} mcp=${a.runner_profile.mcp} bypass=${a.runner_profile.bypass}`,
    `  model:        ${modelLabel(p.model)}`,
    `  artifacts:    constitution ${a.artifacts.constitution_sha256.slice(0, 12)}  specify ${a.artifacts.specify_sha256.slice(0, 12)}  project ${a.artifacts.project_sha256.slice(0, 12)}  receipts ${a.artifacts.receipts.count}@${a.artifacts.receipts.latest_sha256.slice(0, 12)}`,
    `  prompt/context hash: ${a.prompt_sha256.slice(0, 12)} / ${a.contract_sha256.slice(0, 12)}`, `  authorization digest: ${p.digest}`,
    '  Nothing is committed, merged, published or cleaned up by dac. Persisting documentation did not authorize this.');
  if (p.baseline) {
    L.push(`  reviewed baseline (${p.baseline.files.length} file(s); explicit list, never "git add ."):`, ...p.baseline.files.map((f) => `    + ${f.path}`), ...p.baseline.excluded.map((f) => `    - ${f.path} (excluded: ${f.reason})`));
  }
  return L.join('\n');
};

const approvalRecordDigest = (a) => digestOf({ digest: a.digest, nonce: a.nonce, approved_at: a.approved_at, expires_at: a.expires_at, channel: a.channel });
function storedApproval(state, root, digest, now) {
  const a = readJson(join(state, `approvals-${sha256(root).slice(0, 10)}`, `${digest}.json`));
  if (!a || a.digest !== digest || a.channel !== 'trusted-tty' || typeof a.expires_at !== 'string' || typeof a.approved_at !== 'string') return null;
  if (a.record_digest !== approvalRecordDigest(a)) return null;
  const exp = Date.parse(a.expires_at); const ap = Date.parse(a.approved_at);
  // Canonical Writer TTL only: the stored expiry must be exactly approved_at + TTL_SECONDS, and reuse stops AT expiry.
  if (!Number.isFinite(exp) || !Number.isFinite(ap) || exp !== ap + TTL_SECONDS * 1000 || now >= exp) return null;
  return a;
}

export async function implementTask({ root, taskId, flags = {}, deps = {} }) {
  const log = deps.log ?? console.log;
  const clock = deps.clock ?? Date.now; const random = deps.random ?? ((n) => randomBytes(n).toString('hex'));
  const state = stateRoot(deps);
  assertStateOutside(state, root);
  const pid = resolveProjectId(root, flags.project);
  const p = prepare({ root, pid, taskId, flags, state, deps });
  log(summary(p, root));

  // ---- trusted-terminal authorization (or an exact, still-valid earlier one) ----
  let approval = p.info.unborn ? null : storedApproval(state, root, p.digest, clock());
  if (approval) log(`authorization: an earlier trusted-terminal approval for this exact digest is still valid (approved ${approval.approved_at}, expires ${approval.expires_at}); not asking again.`);
  else {
    const term = assertTerminal(deps.terminal ?? (deps.openTerminal ?? openTrustedTerminal)());
    try {
      const now = clock(); const nonce = random(16);
      const auth = { plan_digest: p.digest, nonce, issued_at: new Date(now).toISOString(), expires_at: new Date(now + TTL_SECONDS * 1000).toISOString() };
      const timeoutMs = effectiveConfirmTimeoutMs(auth, clock(), deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_SECONDS * 1000);
      if (timeoutMs <= 0) throw new RunError('APPROVAL_TIMEOUT', 'the authorization expired before confirmation; nothing was created');
      let ok; try { ok = term.confirm(summary(p, root), confirmationPhrase(auth), { timeoutMs }); } catch (e) { if (e?.code === 'APPROVAL_TIMEOUT') throw new RunError('APPROVAL_TIMEOUT', 'confirmation timed out; nothing was created'); throw e; }
      if (!ok) throw new RunError('APPROVAL_DENIED', 'authorization was not given on the trusted terminal; nothing was created');
      const approvedMs = clock();
      approval = { digest: p.digest, nonce, issued_at: auth.issued_at, approved_at: new Date(approvedMs).toISOString(), expires_at: new Date(approvedMs + TTL_SECONDS * 1000).toISOString(), channel: 'trusted-tty' };
      approval.record_digest = approvalRecordDigest(approval);
    } finally { if (!deps.terminal) term.close?.(); }
    // Anything that moved while the human was reading invalidates the authorization BEFORE it is remembered or acted on.
    if (prepare({ root, pid, taskId, flags, state, deps }).digest !== p.digest) throw new RunError('DRIFT', 'the context changed during authorization (artifacts, base, scope, prompt or profile); nothing was created. Run dac implement again to review and authorize the new state.');
    if (!p.info.unborn) { try { writeOnce(join(state, `approvals-${sha256(root).slice(0, 10)}`, `${p.digest}.json`), approval); } catch { /* an identical record already exists */ } }
  }

  return withLock(p.dir, async () => {
    // ---- re-verify immediately before the first side effect: any material drift invalidates the authorization ----
    const again = prepare({ root, pid, taskId, flags, state, deps });
    if (again.digest !== p.digest) throw new RunError('DRIFT', 'the context changed after authorization (artifacts, base, scope, prompt or profile); nothing was created. Run dac implement again to review and authorize the new state.');
    const runId = `r-${new Date(clock()).toISOString().replace(/[-:T.Z]/g, '').slice(0, 17)}-${random(3)}`;
    const runDir = join(p.dir, runId);
    const branch = `${p.authz.worktree.branch_prefix}${runId}`;
    let base = p.info.head;
    if (p.baseline) {
      const made = applyBaseline(root, p.baseline);
      base = made.commit;
      log(`baseline commit ${base.slice(0, 12)} created from the reviewed list (${p.baseline.files.length} file(s)).`);
    }
    writeOnce(join(runDir, 'authorization.json'), { ...p.authz, digest: p.digest, approval });
    const ctxDir = join(runDir, 'context');
    writeOnce(join(ctxDir, 'task-contract.json'), p.contract); writeOnce(join(ctxDir, 'prompt.md'), p.prompt);
    writeOnce(join(ctxDir, 'context.json'), { project_id: pid, task_id: taskId, artifacts: p.ctx.artifacts, prompt_sha256: p.authz.prompt_sha256, contract_sha256: p.authz.contract_sha256, owner: p.ctx.owner });
    const wt = createWorktree(root, { path: join(runDir, 'worktree'), branch, base });
    const run = {
      kind: 'dac-run', schema: 1, run_id: runId, project_id: pid, task_id: taskId, created_at: new Date(clock()).toISOString(), authorization_digest: p.digest,
      base_commit: base, branch, object_format: p.info.format, worktree: { path: wt.path, git_file: wt.gitFile }, artifacts: p.ctx.artifacts,
      runner: { id: p.runner.id, profile: p.profile, model: p.authz.model }, contract_sha256: p.authz.contract_sha256, prompt_sha256: p.authz.prompt_sha256,
      pre: { meta: metaFingerprint(root), wtmeta: worktreeMetaFingerprint(wt.path), main: mainFingerprint(root), evidence: evidenceFingerprint(state, root, p.dir, runId) }, dirty_preserved: p.dirty.length,
    };
    const runSha = writeOnce(join(runDir, 'run.json'), run);
    log(`run ${runId}: worktree ${wt.path}\n  branch ${branch}\n  launching ${p.runner.id} (sandboxed; the worktree is isolation, not a sandbox: the audit decides)`);

    let provider = null; let failure = null;
    try { provider = await p.runner.run({ cwd: wt.path, prompt: p.prompt, contract: p.contract, contextDir: ctxDir, runDir, network: p.network, model: p.model, profile: p.profile }); } catch (e) { failure = e; }
    const result = provider?.result ?? null;
    const resultErrors = result ? contractErrors('result', result) : [failure ? `runner failed: ${failure.message}` : 'the runner returned no result'];
    if (result) writeOnce(join(runDir, 'result.json'), result);

    // ---- comprehensive, blocking audit (always runs, also after a runner failure) ----
    const a = auditWorktree({ root, run, contract: p.contract, pre: run.pre, environment: true, claimedFiles: resultErrors.length ? null : result.files_changed, external: { evidenceChanged: evidenceFingerprint(state, root, p.dir, runId) !== run.pre.evidence } });
    const auditDoc = { ...a.body, audit_hash: a.audit_hash, content_hash: a.content_hash, warnings: a.warnings };
    const auditSha = writeOnce(join(runDir, 'audit.json'), auditDoc);
    const diffSha = a.diff ? writeOnce(join(runDir, 'diff.patch'), a.diff) : null;
    const reviewable = a.body.status === 'PASS' && !failure && resultErrors.length === 0 && ['COMPLETE', 'PARTIAL'].includes(result.execution_status);
    const status = reviewable ? 'READY_FOR_REVIEW' : failure ? 'RUNNER_FAILED' : a.body.status === 'BLOCKED' ? 'AUDIT_BLOCKED' : 'NOT_REVIEWABLE';
    writeOnce(join(runDir, 'outcome.json'), { run_id: runId, status, finished_at: new Date(clock()).toISOString(), run_sha256: runSha, audit_file_sha256: auditSha, audit_hash: a.audit_hash, diff_sha256: diffSha, result_errors: resultErrors, runner_error: failure ? failure.message : null, provider_status: result?.execution_status ?? null });
    log(`audit: ${a.body.status} (${a.body.totals.files} changed file(s), ${a.body.violation_count} violation(s)) audit hash ${a.audit_hash}`);
    for (const v of a.body.violations.slice(0, 20)) log(`  VIOLATION ${v.rule} ${v.path}: ${v.detail}`);
    for (const w of a.warnings) log(`  warning: ${w}`);
    if (resultErrors.length) log(`result: ${resultErrors[0]}`);
    log(`outcome: ${status}. Evidence and worktree are preserved at ${runDir} (nothing was committed, merged, published or cleaned up).`);
    if (status === 'READY_FOR_REVIEW') log(`next: dac review ${taskId}${listRuns(p.dir).filter((r) => r.outcome?.status === 'READY_FOR_REVIEW').length > 1 ? ` --run ${runId}` : ''}`);
    return status === 'READY_FOR_REVIEW' ? 0 : 1;
  });
}
