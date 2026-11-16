// Provider-neutral, in-memory SDD handoff store. Payload lives only in the custodian process memory (never on disk).
// A handoff is a capability, NOT an approval: approval remains the writer's /dev/tty confirmation.
import { createHash, randomBytes } from 'node:crypto';

export const HANDOFF_TTL_MS = 600 * 1000; // exactly 600 seconds
export const MAX_LIVE_HANDOFFS = 16;
export const MAX_ENVELOPE_BYTES = 512 * 1024;
export const ID_RE = /^sdd-h2\.([0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export class HandoffError extends Error {
  constructor(code, message) { super(message); this.name = 'HandoffError'; this.code = code; }
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export function parseHandoffId(id) {
  const m = typeof id === 'string' && id.length < 100 ? ID_RE.exec(id) : null;
  if (!m) throw new HandoffError('HANDOFF_ID', 'handoff id is malformed');
  return { instanceId: m[1], secret: m[2] };
}

export const sameTarget = (a, b) => !!a && !!b && a.realpath === b.realpath && a.device === b.device && a.inode === b.inode;

// target: identity fixed when the custodian started. Entries are keyed by sha256(secret); the secret is never stored.
export function createStore({ instanceId, target, clock = Date.now, random = (n) => randomBytes(n) }) {
  const entries = new Map(); // key -> { json, digest, target, created, expires, leased }
  const purge = () => { const now = clock(); for (const [k, e] of entries) if (now >= e.expires) entries.delete(k); };
  const find = (id, tgt) => {
    const { instanceId: b, secret } = parseHandoffId(id);
    purge();
    const key = sha256(secret);
    const e = b === instanceId ? entries.get(key) : undefined;
    // Unknown, expired, consumed, cancelled and other-instance ids are indistinguishable (no oracle).
    if (!e) throw new HandoffError('HANDOFF_NOT_FOUND', 'handoff is unknown, expired or already consumed');
    if (!sameTarget(tgt, e.target)) throw new HandoffError('TARGET_MISMATCH', 'handoff target does not match the requested target');
    return { key, e };
  };
  const view = (e) => ({ payload_json: e.json, payload_digest: e.digest, target: e.target, expires_at: new Date(e.expires).toISOString() });
  return {
    get size() { purge(); return entries.size; },
    purgeExpired() { purge(); },
    submit(payload) {
      purge();
      if (entries.size >= MAX_LIVE_HANDOFFS) throw new HandoffError('HANDOFF_CAPACITY', `at most ${MAX_LIVE_HANDOFFS} live handoffs are allowed`);
      const json = JSON.stringify(payload);
      if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_ENVELOPE_BYTES) throw new HandoffError('HANDOFF_TOO_LARGE', `envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`);
      const secret = random(32).toString('base64url');
      const created = clock();
      entries.set(sha256(secret), { json, digest: sha256(json), target, created, expires: created + HANDOFF_TTL_MS, leased: false });
      return { handoff_id: `sdd-h2.${instanceId}.${secret}`, payload_digest: sha256(json), created_at: new Date(created).toISOString(), expires_at: new Date(created + HANDOFF_TTL_MS).toISOString() };
    },
    // Non-consuming read (used by plan).
    peek(id, tgt) { return view(find(id, tgt).e); },
    // Exclusive lease (used by apply). commit() consumes (drops the payload); release() frees the lease.
    lease(id, tgt) {
      const { key, e } = find(id, tgt);
      if (e.leased) throw new HandoffError('HANDOFF_LEASED', 'handoff is currently leased by another apply');
      e.leased = true;
      let done = false;
      return {
        view: view(e),
        commit() { if (done) return false; done = true; const live = entries.get(key) === e && clock() < e.expires; entries.delete(key); return live; },
        release() { if (done) return; done = true; e.leased = false; },
      };
    },
    // Human cancel: drops a handoff that is not leased.
    cancel(id, tgt) {
      const { key, e } = find(id, tgt);
      if (e.leased) throw new HandoffError('HANDOFF_LEASED', 'handoff is currently leased by an apply');
      entries.delete(key);
      return true;
    },
    clear() { entries.clear(); },
    nextExpiryMs() { purge(); let m = Infinity; for (const e of entries.values()) m = Math.min(m, e.expires); return m; },
  };
}
