// One-use human authorization for a single canonical plan.
// Approval exists ONLY when this module opens the controlling terminal itself (/dev/tty), shows the exact
// plan and digest, and the human types the exact confirmation phrase. A JSON record, argument, environment
// variable, stdin/pipe, a --yes style flag, or model text are never approvals. Fails closed without a TTY.
import { openSync, closeSync, readSync, writeSync, constants as fsc } from 'node:fs';
import { isatty } from 'node:tty';
import { WriterError, canonicalize, digestOf, NONCE_RE } from './artifacts.mjs';

export const TTL_SECONDS = 600;
export const MAX_FUTURE_SKEW_SECONDS = 30;
export const CONFIRM_TIMEOUT_SECONDS = 120; // default interactive confirmation timeout (always capped by expires_at)
const FIELDS = ['plan_digest', 'target', 'operation', 'project_id', 'prior_state', 'standard_commit', 'nonce', 'issued_at', 'expires_at'];
const BOUND = ['plan_digest', 'target', 'operation', 'project_id', 'prior_state', 'standard_commit'];

export function mintAuthorization(plan, digest, { nonce, nowMs }) {
  return {
    plan_digest: digest, target: plan.target, operation: plan.operation, project_id: plan.project_id,
    prior_state: plan.prior_state, standard_commit: plan.standard_commit, nonce,
    issued_at: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + TTL_SECONDS * 1000).toISOString(),
  };
}

const parseTime = (s) => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isNaN(t) || new Date(t).toISOString() !== s ? null : t; };

// Returns a list of failures ({ code, message }); empty means the authorization is valid at nowMs for `expected`.
// expected: the freshly recomputed { plan_digest, target, operation, project_id, prior_state, standard_commit }.
export function checkAuthorization(auth, expected, nowMs) {
  const fail = [];
  const add = (code, message) => fail.push({ code, message });
  if (!auth || typeof auth !== 'object' || Array.isArray(auth) || JSON.stringify(Object.keys(auth).sort()) !== JSON.stringify([...FIELDS].sort())) return [{ code: 'AUTH_MALFORMED', message: 'authorization has unexpected shape' }];
  if (typeof auth.nonce !== 'string' || !NONCE_RE.test(auth.nonce)) add('AUTH_MALFORMED', 'nonce is invalid');
  const issued = parseTime(auth.issued_at);
  const expires = parseTime(auth.expires_at);
  if (issued === null || expires === null) { add('AUTH_MALFORMED', 'timestamps are invalid'); return fail; }
  if (expires - issued !== TTL_SECONDS * 1000) add('AUTH_TTL', `authorization lifetime must be exactly ${TTL_SECONDS} seconds`);
  // Skew tolerance applies to issued_at only and never moves expires_at.
  if (issued > nowMs + MAX_FUTURE_SKEW_SECONDS * 1000) add('AUTH_ISSUED_IN_FUTURE', `issued_at is more than ${MAX_FUTURE_SKEW_SECONDS} seconds in the future`);
  if (nowMs >= expires) add('AUTH_EXPIRED', 'authorization expired');
  for (const k of BOUND) if (digestOf(canonicalize(auth[k] ?? null)) !== digestOf(canonicalize(expected[k] ?? null))) add('AUTH_MISMATCH', `authorization does not match the current ${k}`);
  return fail;
}

// Effective confirmation timeout: min(configured, time left until expires_at). The 30 s skew tolerance applies to
// issued_at only and is never added here. Returns milliseconds; <= 0 means the authorization is already expired.
export function effectiveConfirmTimeoutMs(auth, nowMs, configuredMs = CONFIRM_TIMEOUT_SECONDS * 1000) {
  const expires = parseTime(auth.expires_at);
  if (expires === null || !Number.isFinite(configuredMs) || configuredMs <= 0) return 0;
  return Math.min(configuredMs, expires - nowMs);
}

export const confirmationPhrase = (auth) => `approve ${auth.plan_digest.slice(0, 12)} ${auth.nonce.slice(0, 8)}`;

// Opens the controlling terminal. Throws TTY_REQUIRED (zero writes) when there is none.
export function openTrustedTerminal({ now = Date.now, sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  let fd;
  try { fd = openSync('/dev/tty', fsc.O_RDWR | fsc.O_NONBLOCK); } catch { throw new WriterError('TTY_REQUIRED', 'a trusted interactive terminal is required; approval cannot come from arguments, environment, stdin, files or model output'); }
  if (!isatty(fd)) { closeSync(fd); throw new WriterError('TTY_REQUIRED', 'a trusted interactive terminal is required'); }
  return {
    trusted: true,
    // Throws APPROVAL_TIMEOUT when no complete line arrives within timeoutMs (the deadline is enforced even
    // while the human is typing). Reading is non-blocking and polled so the timeout cannot hang on the tty.
    confirm(text, phrase, { timeoutMs } = {}) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WriterError('APPROVAL_TIMEOUT', 'confirmation timed out (no time left)');
      const deadline = now() + timeoutMs;
      try { writeSync(fd, `${text}\nType exactly "${phrase}" within ${Math.ceil(timeoutMs / 1000)}s to approve, anything else to cancel: `); } catch { return false; }
      const one = Buffer.alloc(1);
      let line = '';
      while (line.length < 256) {
        if (now() >= deadline) throw new WriterError('APPROVAL_TIMEOUT', 'confirmation timed out; nothing was written');
        let n;
        try { n = readSync(fd, one, 0, 1, null); } catch (e) {
          if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') { sleepMs(Math.min(25, Math.max(1, deadline - now()))); continue; }
          return false;
        }
        if (n === 0 || one[0] === 10) break;
        line += String.fromCharCode(one[0]);
      }
      return line.trim() === phrase;
    },
    close() { try { closeSync(fd); } catch { /* already closed */ } },
  };
}

export function assertTerminal(t) {
  if (!t || typeof t.confirm !== 'function') throw new WriterError('TTY_REQUIRED', 'a trusted interactive terminal is required');
  return t;
}
