// Provider-neutral SDD Artifact Writer: plan | apply | verify.
// One mutation engine: all writes go through executeActions (adapters/shared/apply.mjs) and its journal.
// Persists only under the project-owned .sdd/ allowlist; never reads or writes .dac/.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { REPO_ROOT } from '../../../installer/lib/run.mjs';
import { executeActions, resolveTarget, inspect } from '../apply.mjs';
import { sha256 } from '../canonical.mjs';
import { verifySource } from '../source.mjs';
import {
  WriterError, ARTIFACT_NAMES, MAX_ARTIFACT_BYTES, ID_RE, RECEIPT_NAME_RE, SDD_ROOT, VALIDATORS,
  artifactPath, receiptPath, consumedPath, assertAllowedPath, readDestination, canonicalBytes, digestOf, canonicalize,
  renderMarkdown, schemaErrors, isSha, MARKDOWN_NAMES,
} from './artifacts.mjs';
import { TTL_SECONDS, MAX_FUTURE_SKEW_SECONDS, CONFIRM_TIMEOUT_SECONDS, effectiveConfirmTimeoutMs, mintAuthorization, checkAuthorization, confirmationPhrase, openTrustedTerminal, assertTerminal } from './authorization.mjs';
import { acquireLock, recoverLock } from './lock.mjs';

export { WriterError };

// The provider contract: identical for every provider. There is no provider parameter anywhere.
export const CONTRACT = Object.freeze({
  version: 1,
  operations: Object.freeze(['plan', 'apply', 'verify']),
  artifacts: ARTIFACT_NAMES,
  storage_root: SDD_ROOT,
  gate: 'sdd-artifact-write',
  approval: 'trusted-tty',
  ttl_seconds: TTL_SECONDS,
  max_future_skew_seconds: MAX_FUTURE_SKEW_SECONDS,
  markdown_default: false,
});

const defaultSource = () => verifySource(REPO_ROOT);
const INPUT_KEYS = ['project_id', 'operation', 'markdown', ...ARTIFACT_NAMES];

function targetIdentity(root) {
  const st = statSync(root, { bigint: true });
  return { realpath: root, device: st.dev.toString(), inode: st.ino.toString() };
}

function checkInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WriterError('INPUT', 'input must be a JSON object');
  const extra = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k));
  if (extra.length) throw new WriterError('INPUT', `unknown input field(s): ${extra.join(', ')}`);
  if (typeof input.project_id !== 'string' || !ID_RE.test(input.project_id) || input.project_id.length > 64) throw new WriterError('INPUT', 'project_id is missing or invalid');
  if (!['create', 'update'].includes(input.operation)) throw new WriterError('INPUT', 'operation must be "create" or "update"');
  if (input.markdown !== undefined && typeof input.markdown !== 'boolean') throw new WriterError('INPUT', 'markdown must be a boolean');
  const names = ARTIFACT_NAMES.filter((n) => input[n] !== undefined);
  if (!names.length) throw new WriterError('INPUT', 'at least one artifact (constitution, specify, project) is required');
  return names;
}

function validateContent(input, names) {
  const errors = [];
  const traceability = { requirements: 0, acceptance_criteria: 0, requirement_to_criterion_links: 0 };
  const desired = new Map();
  for (const n of names) {
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(input[n])); } catch { size = Infinity; }
    if (size > MAX_ARTIFACT_BYTES) { errors.push({ code: 'SDD_ARTIFACT', rule: 'size', path: `$.${n}`, message: 'artifact exceeds the size limit' }); continue; }
    const r = VALIDATORS[n](input[n], input.project_id);
    errors.push(...r.errors.map((e) => ({ ...e, path: `${n}${e.path.slice(1)}` })));
    if (r.errors.length) continue;
    if (n === 'specify') Object.assign(traceability, r.summary);
    desired.set(artifactPath(input.project_id, n, 'json'), canonicalBytes(input[n]));
    if (input.markdown === true && MARKDOWN_NAMES.includes(n)) desired.set(artifactPath(input.project_id, n, 'md'), renderMarkdown(n, input[n]));
  }
  if (errors.length) throw new WriterError('VALIDATION', `artifact validation failed (${errors.length} error(s))`, { errors });
  return { desired, traceability };
}

// Reads the receipt store of a project: contiguous sequence, no foreign entries.
function readReceipts(root, pid) {
  const dir = `${SDD_ROOT}/receipts/${pid}`;
  let names = [];
  try {
    const st = lstatSync(join(root, ...dir.split('/')));
    if (st.isSymbolicLink() || !st.isDirectory()) throw new WriterError('PATH_POLICY', 'path rejected: receipt store is not a real directory');
    names = readdirSync(join(root, ...dir.split('/'))).sort();
  } catch (e) { if (e instanceof WriterError) throw e; if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new WriterError('STATE_UNVERIFIED', 'receipt store cannot be inspected'); if (e.code === 'ENOTDIR') throw new WriterError('PATH_POLICY', 'path rejected: receipt store path is not a directory'); }
  const list = names.map((n) => { const m = RECEIPT_NAME_RE.exec(n); if (!m) throw new WriterError('STATE_UNVERIFIED', 'unexpected entry in the receipt store; run verify', { entry: n }); return { name: n, seq: Number(m[1]), path: `${dir}/${n}` }; });
  list.forEach((r, i) => { if (r.seq !== i + 1) throw new WriterError('STATE_UNVERIFIED', 'receipt sequence is not contiguous; run verify'); });
  const latest = list.at(-1);
  let latestSha = 'none';
  if (latest) latestSha = readDestination(root, latest.path).sha256;
  return { count: list.length, latest_sha256: latestSha };
}

// Pure function of the explicit input and the current on-disk state. Performs no writes.
function buildPlan(root, input, src) {
  const names = checkInput(input);
  if (!/^[0-9a-f]{40}$/.test(src?.head ?? '')) throw new WriterError('STANDARD_SOURCE', 'the standard commit cannot be verified');
  const { desired, traceability } = validateContent(input, names);
  const pid = input.project_id;
  const files = [];
  const priorFiles = {};
  for (const path of [...desired.keys()].sort()) {
    assertAllowedPath(path, pid);
    const cur = readDestination(root, path);
    const after = sha256(desired.get(path));
    priorFiles[path] = cur.kind === 'missing' ? 'missing' : cur.sha256;
    if (input.operation === 'create' && cur.kind !== 'missing') throw new WriterError('OPERATION_MISMATCH', `operation "create" but ${path} already exists; use "update"`, { path });
    if (input.operation === 'update' && cur.kind === 'missing' && path.endsWith('.json')) throw new WriterError('OPERATION_MISMATCH', `operation "update" but ${path} does not exist; use "create"`, { path });
    const op = cur.kind === 'missing' ? 'create' : cur.sha256 === after ? 'unchanged' : 'update';
    files.push({ path, op, before_sha256: priorFiles[path], after_sha256: after });
  }
  // The destination directories themselves must be usable (symlinks / aliases), even when nothing exists yet.
  readDestination(root, assertAllowedPath(consumedPath(pid, '0'.repeat(32)), pid));
  const receipts = readReceipts(root, pid);
  const plan = {
    schema: 1, kind: 'sdd-artifact-plan', project_id: pid, operation: input.operation, standard_commit: src.head,
    target: targetIdentity(root), markdown: input.markdown === true,
    files,
    prior_state: { files: priorFiles, receipts },
    validation: { status: 'valid', artifacts: names },
    traceability,
  };
  const changes = files.filter((f) => f.op !== 'unchanged');
  return { plan, digest: digestOf(plan), desired, changes };
}

export function plan({ target, input, source = defaultSource }) {
  const root = resolveTarget(target);
  const p = buildPlan(root, input, source());
  return {
    status: p.changes.length ? 'PLANNED' : 'UNCHANGED',
    plan: p.plan, plan_digest: p.digest,
    authorization_required: p.changes.length > 0,
    would_write: p.changes.map((f) => f.path),
    files_changed: [],
  };
}

const promptText = (p, auth) => [
  'SDD Artifact Writer: approval requested',
  `  project:         ${p.plan.project_id}`,
  `  operation:       ${p.plan.operation}`,
  `  target:          ${p.plan.target.realpath} (device ${p.plan.target.device}, inode ${p.plan.target.inode})`,
  `  standard commit: ${p.plan.standard_commit}`,
  `  plan digest:     ${p.digest}`,
  `  nonce:           ${auth.nonce}`,
  `  issued_at:       ${auth.issued_at}`,
  `  expires_at:      ${auth.expires_at} (${TTL_SECONDS}s)`,
  '  files:',
  ...p.plan.files.map((f) => `    ${f.op.padEnd(9)} ${f.path}  ${f.before_sha256.slice(0, 12)} -> ${f.after_sha256.slice(0, 12)}`),
  '  plus a receipt and a one-use consumed marker (same transaction).',
].join('\n');

// Recomputation after the first plan: a different on-disk state is drift, whatever rule it trips.
function recompute(root, input, src) {
  try { return buildPlan(root, input, src); } catch (e) {
    if (e instanceof WriterError && e.code === 'OPERATION_MISMATCH') throw new WriterError('DRIFT', 'the target state changed after the plan was computed', { files_changed: [], rollback: { status: 'not-needed', failed_paths: [] } });
    throw e;
  }
}

function failWith(code, message, details = {}) { throw new WriterError(code, message, { files_changed: [], rollback: { status: 'not-needed', failed_paths: [] }, ...details }); }

export function apply({ target, input, source = defaultSource, terminal = null, clock = Date.now, random = () => randomBytes(16).toString('hex'), recoverLock: recover = false, hooks = {}, faultAfter = null, confirmTimeoutMs = CONFIRM_TIMEOUT_SECONDS * 1000, openTerminal = openTrustedTerminal }) {
  // apply always requires the trusted terminal: fail closed before reading anything or writing (lock included).
  const term = assertTerminal(terminal ?? openTerminal());
  let lock = null;
  try {
    const root = resolveTarget(target);
    const first = buildPlan(root, input, source());
    if (!first.changes.length) return { status: 'UNCHANGED', plan_digest: first.digest, project_id: first.plan.project_id, files_changed: [] };
    const pid = first.plan.project_id;
    let recovery = null;
    try {
      lock = acquireLock(root, { projectId: pid, target: first.plan.target, nowMs: clock() });
    } catch (e) {
      if (!(e.code === 'LOCKED' && recover)) throw e;
      recovery = recoverLock(root, { projectId: pid, terminal: term, hooks, confirmTimeoutMs });
      const state = verify({ target: root, projectId: pid });
      if (state.status !== 'OK') throw new WriterError('RECOVERY_STATE_UNVERIFIED', 'the stale lock was removed but the target state does not verify; inspect and repair manually', { recovery, findings: state.findings });
      lock = acquireLock(root, { projectId: pid, target: first.plan.target, nowMs: clock() });
    }
    hooks.afterLock?.();

    // Recompute under the lock; any difference from the earlier plan fails closed.
    const locked = recompute(root, input, source());
    if (locked.digest !== first.digest) failWith('DRIFT', 'the plan changed after it was first computed (plan, target or standard commit drift)');

    const auth = mintAuthorization(locked.plan, locked.digest, { nonce: random(), nowMs: clock() });
    // Timeout = min(configured, time left until expires_at); skew never extends it. Expired => no prompt at all.
    const timeoutMs = effectiveConfirmTimeoutMs(auth, clock(), confirmTimeoutMs);
    if (timeoutMs <= 0) failWith('APPROVAL_TIMEOUT', 'the authorization expired before confirmation; nothing was written');
    let confirmed;
    try { confirmed = term.confirm(promptText(locked, auth), confirmationPhrase(auth), { timeoutMs }); } catch (e) {
      if (e?.code === 'APPROVAL_TIMEOUT') failWith('APPROVAL_TIMEOUT', 'confirmation timed out; nothing was written and the authorization was not consumed');
      throw e;
    }
    if (!confirmed) failWith('APPROVAL_DENIED', 'approval was not given on the trusted terminal');
    const approvedAt = new Date(clock()).toISOString();
    const approvedDigest = digestOf(auth);
    hooks.afterApproval?.(auth);
    if (digestOf(auth) !== approvedDigest) failWith('AUTH_ALTERED', 'the authorization changed after approval');
    hooks.beforeFirstWrite?.();

    // Immediately before the first write: recompute everything and revalidate the authorization.
    const final = recompute(root, input, source());
    const fails = checkAuthorization(auth, { plan_digest: final.digest, target: final.plan.target, operation: final.plan.operation, project_id: final.plan.project_id, prior_state: final.plan.prior_state, standard_commit: final.plan.standard_commit }, clock());
    if (fails.length) failWith(fails[0].code === 'AUTH_MISMATCH' ? 'DRIFT' : fails[0].code, `${fails[0].message}`, { failures: fails });
    const marker = consumedPath(pid, auth.nonce);
    if (readDestination(root, marker).kind !== 'missing') failWith('AUTH_REPLAYED', 'this authorization nonce was already consumed');

    // Build the single transaction: artifacts, receipt, consumed marker.
    const seq = final.plan.prior_state.receipts.count + 1;
    const rPath = receiptPath(pid, seq, final.digest);
    const written = [...final.changes.map((f) => f.path), rPath, marker].sort();
    const receipt = {
      kind: 'sdd-write-receipt', schema_version: '1.0', sequence: seq, project_id: pid, operation: final.plan.operation,
      standard_commit: final.plan.standard_commit, plan_digest: final.digest, plan: final.plan,
      authorization: { nonce: auth.nonce, issued_at: auth.issued_at, expires_at: auth.expires_at, ttl_seconds: TTL_SECONDS, approval: { channel: 'trusted-tty', approved_at: approvedAt } },
      previous_receipt_sha256: final.plan.prior_state.receipts.latest_sha256,
      files: final.plan.files, files_changed: written, consumed_marker: marker,
      validation: final.plan.validation, traceability: final.plan.traceability,
      verification: { mode: 'in-transaction-reread', scope: 'every file written by the transaction, re-read from disk and hash-compared', status: 'required-before-commit' },
    };
    receipt.receipt_digest = digestOf(receipt);
    const markerDoc = { kind: 'sdd-consumed-nonce', schema_version: '1.0', nonce: auth.nonce, plan_digest: final.digest, project_id: pid, receipt: rPath, consumed_at: approvedAt };
    const actions = [
      ...final.changes.map((f) => (f.op === 'create'
        ? { op: 'create', path: f.path, buf: final.desired.get(f.path) }
        : { op: 'update', path: f.path, buf: final.desired.get(f.path), previous: readDestination(root, f.path).buf })),
      { op: 'create', path: rPath, buf: canonicalBytes(receipt) },
      { op: 'create', path: marker, buf: canonicalBytes(markerDoc) },
    ];
    for (const a of actions) assertAllowedPath(a.path, pid);
    if (actions.some((a) => a.op === 'remove')) throw new WriterError('INTERNAL', 'the writer never removes files');

    const observed = [];
    try {
      executeActions(root, actions, {
        faultAfter,
        verifyInTransaction: () => {
          hooks.duringVerify?.(root);
          observed.length = 0;
          for (const a of actions) {
            const cur = inspect(root, a.path);
            const expected = sha256(a.buf);
            const got = cur.kind === 'file' ? sha256(cur.buf) : cur.kind;
            if (got !== expected) throw new WriterError('VERIFY_FAILED', `post-write verification failed for ${a.path}`, { path: a.path, expected_sha256: expected, observed: got });
            observed.push({ path: a.path, sha256: expected });
          }
          for (const n of ARTIFACT_NAMES) {
            const a = actions.find((x) => x.path === artifactPath(pid, n, 'json'));
            if (a && VALIDATORS[n](JSON.parse(a.buf.toString('utf8')), pid).errors.length) throw new WriterError('VERIFY_FAILED', `written ${n} artifact no longer validates`, { path: a.path });
          }
          const rcpt = JSON.parse(actions.find((x) => x.path === rPath).buf.toString('utf8'));
          const { receipt_digest: d, ...rest } = rcpt;
          if (schemaErrors('receipt', rcpt).length || d !== digestOf(rest)) throw new WriterError('VERIFY_FAILED', 'written receipt is not self-consistent', { path: rPath });
        },
      });
    } catch (e) {
      const cause = e.cause instanceof WriterError ? e.cause : null;
      const failedPaths = e.rollbackFailures ?? [];
      throw new WriterError(cause?.code ?? e.code ?? 'APPLY_FAILED', cause ? cause.message : e.message, {
        files_changed: failedPaths, // what may still differ from the prior state (empty when rollback was clean)
        rollback: { status: failedPaths.length ? 'failed' : 'clean', failed_paths: failedPaths },
        evidence: cause?.details ?? (e.cause ? { error: String(e.cause.message ?? e.cause) } : {}),
        message_detail: e.message,
      });
    }
    return {
      status: 'APPLIED', project_id: pid, operation: final.plan.operation, plan_digest: final.digest, standard_commit: final.plan.standard_commit,
      sequence: seq, receipt: rPath, consumed_marker: marker, files_changed: written,
      verification: { status: 'passed', files: observed },
      ...(recovery ? { recovery } : {}),
    };
  } finally {
    lock?.release();
    if (!terminal) term.close?.();
  }
}

// Read-only. Re-reads the disk and checks artifacts against the receipt chain; never repairs.
export function verify({ target, projectId }) {
  const root = resolveTarget(target);
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) throw new WriterError('INPUT', 'project id is missing or invalid');
  const findings = [];
  const add = (kind, path, reason) => findings.push({ kind, path, reason });
  let checked = 0;

  // .dac-tmp leftovers anywhere under .sdd (symlinks are reported, never followed)
  const walk = (rel) => {
    let names;
    try { names = readdirSync(join(root, ...rel.split('/'))); } catch { return; }
    for (const n of names) {
      const p = `${rel}/${n}`;
      let st; try { st = lstatSync(join(root, ...p.split('/'))); } catch { continue; }
      if (n.includes('.dac-tmp')) add('leftover', p, 'temporary file left by an interrupted write');
      if (st.isSymbolicLink()) add('symlink', p, 'symlink under .sdd');
      else if (st.isDirectory()) walk(p);
    }
  };
  try {
    const st = lstatSync(join(root, SDD_ROOT));
    if (st.isSymbolicLink() || !st.isDirectory()) { add('symlink', SDD_ROOT, '.sdd is not a real directory'); return { status: 'DRIFT', findings, files_checked: 0, files_changed: [] }; }
    walk(SDD_ROOT);
  } catch { return { status: 'OK', findings, files_checked: 0, files_changed: [], note: 'no .sdd directory' }; }

  const lockRel = `${SDD_ROOT}/locks/${projectId}.lock`;
  if (inspect(root, lockRel).kind !== 'missing') add('lock', lockRel, 'a lock file is present');

  // receipt chain
  const rDir = `${SDD_ROOT}/receipts/${projectId}`;
  let names = [];
  try { names = readdirSync(join(root, ...rDir.split('/'))).sort(); } catch { /* none */ }
  const latestFor = new Map(); // path -> after_sha256 from the newest receipt that lists it
  let prevSha = 'none';
  const consumedDir = `${SDD_ROOT}/consumed/${projectId}`;
  const nonces = new Set();
  names.forEach((n, i) => {
    const p = `${rDir}/${n}`;
    const m = RECEIPT_NAME_RE.exec(n);
    if (!m || Number(m[1]) !== i + 1) { add('receipt', p, 'unexpected receipt name or sequence gap'); return; }
    const cur = inspect(root, p);
    if (cur.kind !== 'file') { add('receipt', p, `receipt unusable (${cur.reason ?? cur.kind})`); return; }
    checked++;
    let r;
    try { r = JSON.parse(cur.buf.toString('utf8')); } catch { add('receipt', p, 'receipt is not valid JSON'); return; }
    const errs = schemaErrors('receipt', r);
    if (errs.length) { add('receipt', p, `receipt schema invalid: ${errs[0].path} ${errs[0].message}`); return; }
    const { receipt_digest: d, ...rest } = r;
    if (!canonicalBytes(r).equals(cur.buf)) add('receipt', p, 'receipt is not in canonical form');
    if (d !== digestOf(rest)) add('receipt', p, 'receipt digest mismatch (modified)');
    if (digestOf(r.plan) !== r.plan_digest) add('receipt', p, 'plan digest does not match the recorded plan');
    if (r.sequence !== i + 1 || m[2] !== r.plan_digest.slice(0, 12) || r.project_id !== projectId) add('receipt', p, 'receipt name, sequence or project disagrees with its content');
    if (r.previous_receipt_sha256 !== prevSha) add('receipt', p, 'receipt chain is broken');
    prevSha = sha256(cur.buf);
    if (!r.files_changed.includes(p) || !r.files_changed.includes(r.consumed_marker)) add('receipt', p, 'files_changed does not list the receipt and the consumed marker');
    // consumed marker
    nonces.add(r.authorization.nonce);
    const mk = inspect(root, r.consumed_marker);
    if (r.consumed_marker !== `${consumedDir}/${r.authorization.nonce}.json` || mk.kind !== 'file') add('consumed', r.consumed_marker, 'consumed marker is missing');
    else {
      checked++;
      try { const mj = JSON.parse(mk.buf.toString('utf8')); if (mj.nonce !== r.authorization.nonce || mj.plan_digest !== r.plan_digest || mj.receipt !== p) add('consumed', r.consumed_marker, 'consumed marker disagrees with its receipt'); } catch { add('consumed', r.consumed_marker, 'consumed marker is not valid JSON'); }
    }
    for (const f of r.files) latestFor.set(f.path, f.after_sha256);
  });
  let markers = [];
  try { markers = readdirSync(join(root, ...consumedDir.split('/'))); } catch { /* none */ }
  for (const n of markers) if (!nonces.has(n.replace(/\.json$/, ''))) add('consumed', `${consumedDir}/${n}`, 'consumed marker has no receipt');

  // artifacts
  const docs = {};
  for (const n of ARTIFACT_NAMES) {
    const jp = artifactPath(projectId, n, 'json');
    const mp = artifactPath(projectId, n, 'md');
    let disk;
    try { disk = readDestination(root, jp); } catch (e) { add('artifact', jp, e.message); continue; }
    if (disk.kind === 'missing') { if (latestFor.has(jp)) add('missing', jp, 'artifact listed in a receipt is missing'); }
    else {
      checked++;
      let doc = null;
      try { doc = JSON.parse(disk.buf.toString('utf8')); } catch { add('artifact', jp, 'artifact is not valid JSON'); }
      if (doc) {
        const errs = VALIDATORS[n](doc, projectId).errors;
        if (errs.length) add('artifact', jp, `artifact invalid: ${errs[0].path} ${errs[0].message}`);
        else { docs[n] = doc; if (!canonicalBytes(doc).equals(disk.buf)) add('artifact', jp, 'artifact is not in canonical form'); }
      }
      if (!latestFor.has(jp)) add('unreceipted', jp, 'artifact has no receipt');
      else if (latestFor.get(jp) !== disk.sha256) add('modified', jp, 'artifact hash differs from the latest receipt');
    }
    if (!MARKDOWN_NAMES.includes(n)) continue;
    let md;
    try { md = readDestination(root, mp); } catch (e) { add('artifact', mp, e.message); continue; }
    if (md.kind === 'file') {
      checked++;
      if (!docs[n] || !renderMarkdown(n, docs[n]).equals(md.buf)) add('modified', mp, 'derived Markdown differs from its regeneration (hand edit or stale)');
      if (!latestFor.has(mp)) add('unreceipted', mp, 'derived Markdown has no receipt');
      else if (latestFor.get(mp) !== md.sha256) add('modified', mp, 'derived Markdown hash differs from the latest receipt');
    } else if (latestFor.has(mp)) add('missing', mp, 'derived Markdown listed in a receipt is missing');
  }
  return { status: findings.length ? 'DRIFT' : 'OK', findings, files_checked: checked, files_changed: [] };
}
