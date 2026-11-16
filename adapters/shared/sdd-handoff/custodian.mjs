// Handoff custodian: a human-started, foreground, in-memory holder of SDD envelopes, independent of Claude/MCP.
// Unix socket only (no network). Line-delimited JSON ops: submit | peek | lease | commit | release | cancel | status | stop.
// The target is fixed at startup and is never selectable by a client. Nothing is ever written to disk except the
// socket inode and a minimal non-payload discovery metadata file (target identity, socket inode, instance) in the
// automatically resolved private runtime directory (or an explicit advanced/test override). Closing the custodian destroys every handoff.
import net from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { plan } from '../sdd-writer/writer.mjs';
import { createStore, HandoffError, MAX_ENVELOPE_BYTES, HANDOFF_TTL_MS, MAX_LIVE_HANDOFFS, sameTarget } from './core.mjs';
import { resolveRuntimeDir, ensurePrivateDir, assertPrivateDir, assertPrivateSocket, socketPath, writeMetadata, removeMetadata } from './endpoint.mjs';
import { targetIdentity } from './identity.mjs';
import { sanitizeErrors } from './errors.mjs';

const MAX_REQUEST_BYTES = MAX_ENVELOPE_BYTES + 16 * 1024;
const MAX_CONNECTIONS = 32;
const IDLE_MS = 10_000;
const LEASE_IDLE_MS = 11 * 60 * 1000;
const isTarget = (t) => t && typeof t === 'object' && typeof t.realpath === 'string' && typeof t.device === 'string' && typeof t.inode === 'string';

// Connect-probe: the only accepted proof of liveness (never file age). 'stale' = a verified own socket nobody listens on.
// SAFETY INVARIANT: a connect-probe result may only ever be acted on for a socket that has first passed assertPrivateSocket
// (real socket, not a symlink, owned by the current user, mode 0600). That check is part of this function, not a convention
// of its callers, so it cannot be reused on an arbitrary path: an unverified path throws HANDOFF_ENDPOINT and is never connected to.
// Callers that unlink (cleanStaleSocket) additionally require the 'stale' answer, i.e. ECONNREFUSED.
export function probeEndpoint(path, timeoutMs = 2000) {
  try { assertPrivateSocket(path); } catch (e) { return e.code === 'HANDOFF_UNAVAILABLE' ? Promise.resolve('absent') : Promise.reject(e); }
  return new Promise((resolve) => {
    const sock = net.createConnection(path);
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done('unverifiable'), timeoutMs);
    sock.once('connect', () => done('live'));
    sock.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'stale' : e.code === 'ENOENT' ? 'absent' : 'unverifiable'));
  });
}

// Removes a stale socket after verification (private socket owned by us + connection refused). Returns the state.
export async function cleanStaleSocket(path, { dir, identity } = {}) {
  try { assertPrivateSocket(path); } catch (e) { if (e.code === 'HANDOFF_UNAVAILABLE') { if (dir && identity) removeMetadata(dir, identity); return 'absent'; } throw e; }
  const state = await probeEndpoint(path);
  if (state === 'stale') { try { unlinkSync(path); } catch { /* raced */ } if (dir && identity) removeMetadata(dir, identity); }
  return state;
}

export async function startCustodian({ target, dir, clock = Date.now, writePlan = plan, writeDiscovery = writeMetadata, onStopped = () => {} }) {
  const identity = targetIdentity(target); // fixed here; never changes for this custodian's lifetime
  dir = resolveRuntimeDir(dir); // explicit, human-chosen; never tmpdir/env/cwd-derived
  ensurePrivateDir(dir);
  const path = socketPath(dir, identity);
  const state = await cleanStaleSocket(path, { dir, identity });
  if (state === 'live') throw new HandoffError('CUSTODIAN_RUNNING', 'a custodian is already running for this target');
  if (state === 'unverifiable') throw new HandoffError('HANDOFF_ENDPOINT', 'existing socket cannot be verified as stale; not touching it');
  const instanceId = randomBytes(6).toString('hex');
  const startedAt = new Date(clock()).toISOString();
  const store = createStore({ instanceId, target: identity, clock });
  const conns = new Set();
  let closed = false;
  let onStop = () => {};

  const server = net.createServer((sock) => {
    if (conns.size >= MAX_CONNECTIONS) { sock.destroy(); return; }
    conns.add(sock);
    let buf = '';
    let bytes = 0;
    let lease = null;
    sock.setEncoding('utf8');
    sock.setTimeout(IDLE_MS);
    const drop = () => { lease?.release(); lease = null; conns.delete(sock); };
    sock.on('close', drop);
    sock.on('error', () => sock.destroy());
    sock.on('timeout', () => sock.destroy());
    const reply = (o) => { if (!sock.destroyed) sock.write(JSON.stringify(o) + '\n'); };
    const fail = (e) => reply({ ok: false, code: e instanceof HandoffError || typeof e?.code === 'string' ? e.code : 'HANDOFF_FAILURE', message: e instanceof HandoffError || typeof e?.code === 'string' ? e.message : 'handoff failure', ...(e?.details?.errors ? { errors: sanitizeErrors(e.details.errors) } : {}) });
    const needTarget = (req) => { if (!isTarget(req.target)) throw new HandoffError('HANDOFF_PROTOCOL', 'target identity is required'); if (!sameTarget(req.target, identity)) throw new HandoffError('TARGET_MISMATCH', 'handoff target does not match the custodian target'); };
    sock.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES * 2 + 1024) { sock.destroy(); return; }
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1); bytes = Buffer.byteLength(buf);
        let req;
        try { if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) throw new Error('big'); req = JSON.parse(line); } catch { fail(new HandoffError('HANDOFF_PROTOCOL', 'malformed request')); continue; }
        try {
          if (!req || typeof req !== 'object' || Array.isArray(req)) throw new HandoffError('HANDOFF_PROTOCOL', 'malformed request');
          switch (req.op) {
            case 'status': reply({ ok: true, pid: process.pid, instance_id: instanceId, started_at: startedAt, target: identity, live_handoffs: store.size, ttl_seconds: HANDOFF_TTL_MS / 1000, capacity: MAX_LIVE_HANDOFFS, max_payload_bytes: MAX_ENVELOPE_BYTES }); break;
            case 'submit': {
              needTarget(req);
              if (!req.payload || typeof req.payload !== 'object' || Array.isArray(req.payload)) throw new HandoffError('INPUT', 'payload must be an object');
              if (Buffer.byteLength(JSON.stringify(req.payload)) > MAX_ENVELOPE_BYTES) throw new HandoffError('HANDOFF_TOO_LARGE', `envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`);
              const p = writePlan({ target: identity.realpath, input: req.payload }); // existing validators/gates; zero writes
              const h = store.submit(req.payload);
              reply({ ok: true, ...h, status: p.status, plan_digest: p.plan_digest, would_write: p.would_write });
              break;
            }
            case 'peek': needTarget(req); reply({ ok: true, ...store.peek(req.id, req.target) }); break;
            case 'cancel': needTarget(req); store.cancel(req.id, req.target); reply({ ok: true, cancelled: true }); break;
            case 'lease':
              needTarget(req);
              if (lease) throw new HandoffError('HANDOFF_PROTOCOL', 'this connection already holds a lease');
              lease = store.lease(req.id, req.target);
              sock.setTimeout(LEASE_IDLE_MS);
              reply({ ok: true, ...lease.view });
              break;
            case 'commit': case 'release': {
              if (!lease) throw new HandoffError('HANDOFF_PROTOCOL', 'no lease held on this connection');
              const l = lease; lease = null;
              if (req.op === 'commit') reply({ ok: true, consumed: l.commit() }); else { l.release(); reply({ ok: true, released: true }); }
              sock.setTimeout(IDLE_MS);
              break;
            }
            case 'stop': reply({ ok: true, stopping: true }); setImmediate(() => onStop()); break;
            default: throw new HandoffError('HANDOFF_PROTOCOL', 'unknown op');
          }
        } catch (e) { fail(e); }
      }
    });
  });

  await new Promise((resolve, reject) => { server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new HandoffError('CUSTODIAN_RUNNING', 'a custodian is already running for this target') : e)); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  assertPrivateDir(dir);
  const sockStat = lstatSync(path, { bigint: true });
  const ino = sockStat.ino;
  const removeOwnSocket = () => { try { const st = lstatSync(path, { bigint: true }); if (st.isSocket() && st.ino === ino) unlinkSync(path); } catch { /* already gone */ } };
  try { writeDiscovery(dir, identity, { socket: path.slice(dir.length + 1), socketStat: sockStat, instanceId, startedAt }); } catch (e) { await new Promise((r) => server.close(() => r())); removeOwnSocket(); throw e; }

  const timer = setInterval(() => store.purgeExpired(), 5000); timer.unref();
  const close = async () => {
    if (closed) return; closed = true;
    clearInterval(timer);
    store.clear(); // destroys every handoff
    for (const s of conns) s.destroy();
    await new Promise((r) => server.close(() => r()));
    removeOwnSocket();
    removeMetadata(dir, identity, instanceId);
  };
  onStop = async () => { await close(); onStopped(); };
  return { instanceId, socketPath: path, dir, target: identity, store, close };
}
