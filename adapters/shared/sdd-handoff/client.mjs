// Client for the custodian (used by the writer CLI, the custodian CLI and the stateless MCP proxy).
// Fails closed: any endpoint/custodian problem is an error before anything is written.
import net from 'node:net';
import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseHandoffId, HandoffError, sameTarget, MAX_ENVELOPE_BYTES } from './core.mjs';
import { resolveRuntimeDir, socketPath, assertPrivateDir, assertPrivateSocket, readMetadata, assertSocketMatchesMetadata } from './endpoint.mjs';
import { targetIdentity } from './identity.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const MAX_RESPONSE = MAX_ENVELOPE_BYTES * 8; // JSON string-escaping headroom

// Discovery: automatic deterministic runtime dir (platform + uid only; never env/tmpdir/cwd; optional trusted override) -> validated metadata -> socket whose inode must equal the
// recorded one -> connect -> the live custodian must confirm the same instance and target before any request is sent.
async function connect(identity, { dir } = {}) {
  dir = resolveRuntimeDir(dir);
  try { lstatSync(dir); } catch (e) { if (e?.code === 'ENOENT') throw new HandoffError('HANDOFF_UNAVAILABLE', 'handoff custodian is not running (no runtime directory)'); }
  assertPrivateDir(dir);
  const meta = readMetadata(dir, identity);
  if (!meta) throw new HandoffError('HANDOFF_UNAVAILABLE', 'handoff custodian is not running (no endpoint metadata)');
  const path = socketPath(dir, identity);
  assertSocketMatchesMetadata(meta, assertPrivateSocket(path, { bigint: true }));
  const sock = await new Promise((resolve, reject) => {
    const s = net.createConnection(path);
    const unavailable = () => reject(new HandoffError('HANDOFF_UNAVAILABLE', 'handoff custodian is not running or is unreachable'));
    s.once('error', unavailable);
    s.once('connect', () => { s.off('error', unavailable); s.on('error', () => {}); /* late write/reset errors surface via exchange() */ resolve(s); });
  });
  try {
    const hello = check(await exchange(sock, { op: 'status' }));
    if (hello.instance_id !== meta.instance_id || hello.pid !== meta.pid || !sameTarget(hello.target, identity)) throw new HandoffError('HANDOFF_ENDPOINT', 'custodian identity does not match the endpoint metadata');
  } catch (e) { sock.destroy(); throw e; }
  return sock;
}

function exchange(sock, req, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = (fn, v) => { cleanup(); fn(v); };
    const onData = (c) => { buf += c; if (buf.length > MAX_RESPONSE) return done(reject, new HandoffError('HANDOFF_PROTOCOL', 'response too large')); const i = buf.indexOf('\n'); if (i >= 0) { try { done(resolve, JSON.parse(buf.slice(0, i))); } catch { done(reject, new HandoffError('HANDOFF_PROTOCOL', 'malformed custodian response')); } } };
    const onEnd = () => done(reject, new HandoffError('HANDOFF_UNAVAILABLE', 'handoff custodian terminated'));
    const timer = setTimeout(() => done(reject, new HandoffError('HANDOFF_UNAVAILABLE', 'handoff custodian did not answer')), timeoutMs);
    const cleanup = () => { clearTimeout(timer); sock.off('data', onData); sock.off('close', onEnd); sock.off('error', onEnd); };
    sock.setEncoding('utf8'); sock.on('data', onData); sock.once('close', onEnd); sock.once('error', onEnd);
    sock.write(JSON.stringify(req) + '\n', (e) => { if (e) done(reject, new HandoffError('HANDOFF_UNAVAILABLE', 'handoff custodian terminated')); });
  });
}

const check = (res) => {
  if (!res || res.ok !== true) { const e = new HandoffError(typeof res?.code === 'string' ? res.code : 'HANDOFF_FAILURE', typeof res?.message === 'string' ? res.message : 'handoff request failed'); if (res?.errors) e.details = { errors: res.errors }; throw e; }
  return res;
};

function open(res, target) {
  check(res);
  if (typeof res.payload_json !== 'string' || typeof res.payload_digest !== 'string') throw new HandoffError('HANDOFF_PROTOCOL', 'malformed custodian response');
  if (sha256(res.payload_json) !== res.payload_digest) throw new HandoffError('HANDOFF_DIGEST', 'handoff payload does not match its digest');
  if (!sameTarget(res.target, target)) throw new HandoffError('TARGET_MISMATCH', 'handoff target does not match the requested target');
  let payload; try { payload = JSON.parse(res.payload_json); } catch { throw new HandoffError('HANDOFF_PROTOCOL', 'handoff payload is not valid JSON'); }
  return { payload, payload_digest: res.payload_digest, expires_at: res.expires_at };
}

// One-shot request on a fresh connection (stateless).
async function once(targetPath, req, opts) {
  const target = targetIdentity(targetPath);
  const sock = await connect(target, opts);
  try { return await exchange(sock, { ...req, target }); } finally { sock.destroy(); }
}

export const submitHandoff = async (targetPath, payload, opts) => check(await once(targetPath, { op: 'submit', payload }, opts));
export const statusOf = async (targetPath, opts) => check(await once(targetPath, { op: 'status' }, opts));
export const stopCustodian = async (targetPath, opts) => check(await once(targetPath, { op: 'stop' }, opts));
export const cancelHandoff = async (id, targetPath, opts) => { parseHandoffId(id); return check(await once(targetPath, { op: 'cancel', id }, opts)); };
export async function peekHandoff(id, targetPath, opts) {
  parseHandoffId(id);
  const target = targetIdentity(targetPath);
  return open(await once(targetPath, { op: 'peek', id }, opts), target);
}

// Leases the handoff for one apply. `run(payload)` executes the (reused) writer apply and returns its result.
// Consumption is committed only when `shouldConsume(result)` is true (a successful transactional apply); every other
// outcome, including exceptions, releases the lease so the handoff stays retryable until TTL.
// If the writes were persisted but the commit cannot be confirmed, the result is returned with
// handoff.consumption = 'uncertain' + evidence. The writer is never re-run here.
export async function withLease(id, targetPath, run, { shouldConsume = () => true, ...opts } = {}) {
  parseHandoffId(id);
  const target = targetIdentity(targetPath);
  const sock = await connect(target, opts);
  try {
    const h = open(await exchange(sock, { op: 'lease', id, target }), target);
    let result;
    try { result = await run(h.payload); } catch (e) {
      await exchange(sock, { op: 'release' }).catch(() => {});
      // Rollback failed mid-apply: disk state may be partially mutated. Do not throw as an ordinary (retryable) failure and
      // do not consume or re-run: report the original failure plus uncertainty evidence.
      if (e?.details?.rollback?.status === 'failed') {
        const d = e.details;
        return { result: null, failure: { code: typeof e.code === 'string' ? e.code : 'FAILURE', message: typeof e.message === 'string' ? e.message : 'writer failure', files_changed: d.files_changed ?? [], rollback: d.rollback, ...(d.errors ? { errors: d.errors } : {}), ...(d.evidence ? { evidence: d.evidence } : {}) },
          handoff: { consumed: false, consumption: 'uncertain', reason: 'the apply failed and its rollback also failed; disk state may be partially modified; the writer was NOT re-run and the handoff was NOT consumed', evidence: { phase: 'apply', error_code: typeof e.code === 'string' ? e.code : 'FAILURE', writer_status: 'FAILED', plan_digest: null, files_changed: d.files_changed ?? [], rollback: d.rollback, next: 'do NOT re-run apply; inspect the listed paths and run the writer verify command, then cancel the handoff' } } };
      }
      throw e;
    }
    if (!shouldConsume(result)) { await exchange(sock, { op: 'release' }).catch(() => {}); return { result, handoff: { consumed: false, consumption: 'not-consumed' } }; }
    try {
      const r = check(await exchange(sock, { op: 'commit' }));
      return { result, handoff: r.consumed ? { consumed: true, consumption: 'consumed' } : { consumed: false, consumption: 'gone', reason: 'handoff expired or was cancelled before consumption; it can no longer be applied' } };
    } catch (e) {
      return { result, handoff: { consumed: false, consumption: 'uncertain', reason: 'the apply persisted its writes but the custodian commit could not be confirmed; the writer was NOT re-run', evidence: { phase: 'commit', error_code: typeof e?.code === 'string' ? e.code : 'HANDOFF_FAILURE', writer_status: result?.status ?? null, plan_digest: result?.plan_digest ?? null, files_changed: result?.files_changed ?? [], next: 'run the writer verify command; if the custodian is still running, cancel the handoff' } } };
    }
  } finally { sock.destroy(); }
}
