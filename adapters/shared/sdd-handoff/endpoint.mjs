// Unix-socket endpoint rules shared by custodian, client and MCP proxy: a user-private directory (0700) holding a
// 0600 socket whose name is derived deterministically from the real target identity.
import { lstatSync, mkdirSync, chmodSync, realpathSync, openSync, readSync, closeSync, fstatSync, writeSync, renameSync, unlinkSync, constants as FS } from 'node:fs';
import { join, isAbsolute, resolve, dirname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HandoffError, sameTarget } from './core.mjs';
import { endpointKey } from './identity.mjs';

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);
export const MAX_SOCKET_PATH = 100; // sun_path is 104 on macOS, 108 on Linux
export const META_VERSION = 1;
const META_SCHEMA = 'dac-sdd-handoff-endpoint';
const MAX_META_BYTES = 4096;

// ---- runtime directory resolution ---------------------------------------------------------------------------------
// The runtime directory is resolved AUTOMATICALLY and deterministically from the platform and the real UID only. It is never derived from
// any temp-dir setting, HOME, the working directory or any environment variable, so the custodian, the MCP proxy and the Writer (started
// from different shells, cwds and sandboxes) always compute the same endpoint:
//   macOS : /private/tmp/dac-sdd-<uid>      (the real path of the /tmp symlink; the symlink itself is never used)
//   Linux : /run/user/<uid>/dac-sdd         when /run/user/<uid> is a safe private directory (ancestors safe), otherwise /tmp/dac-sdd-<uid>
// Resolution only computes the path. Every component is validated on use (assertPrivateDir / ensurePrivateDir): real directories, owner
// root-or-us, no unsafe writable ancestor, final directory ours with mode 0700, never repaired when foreign.
// An explicit absolute, normalized path stays accepted as an advanced/test override (custodian/writer --runtime-dir); no generated
// configuration uses it and it is never a model/tool argument.
const SOCKET_NAME_BYTES = 'h2-'.length + 20 + '.sock'.length; // h2-<20 hex>.sock
const platformOk = (p) => p === 'darwin' || p === 'linux';

function safeRunUserDir(path, u, fsx) {
  try {
    const st = fsx.lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== u || (st.mode & 0o077) !== 0) return false;
    for (let p = dirname(path); ; p = dirname(p)) {
      const a = fsx.lstatSync(p);
      if (a.isSymbolicLink() || !a.isDirectory() || (a.uid !== 0 && a.uid !== u) || ((a.mode & 0o022) !== 0 && (a.mode & 0o1000) === 0)) return false;
      if (p === dirname(p)) break;
    }
    return true;
  } catch { return false; }
}

// platform/uid/fs are injectable for tests only; production callers pass nothing.
export function automaticRuntimeDir({ platform = process.platform, uid: u = uid(), fs: fsx = { lstatSync } } = {}) {
  if (!platformOk(platform)) throw new HandoffError('HANDOFF_PLATFORM', 'unsupported platform (macOS/Linux only)');
  if (!Number.isInteger(u) || u < 0) throw new HandoffError('HANDOFF_ENDPOINT', 'cannot determine the current user id');
  if (platform === 'darwin') return `/private/tmp/dac-sdd-${u}`;
  return safeRunUserDir(`/run/user/${u}`, u, fsx) ? `/run/user/${u}/dac-sdd` : `/tmp/dac-sdd-${u}`;
}

// value === undefined => automatic. Otherwise an explicit, normalized absolute path (advanced override).
export function resolveRuntimeDir(value, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (!platformOk(platform)) throw new HandoffError('HANDOFF_PLATFORM', 'unsupported platform (macOS/Linux only)');
  let dir = value;
  if (value === undefined) dir = automaticRuntimeDir({ ...deps, platform });
  else if (typeof value !== 'string' || value === '' || value.includes('\0') || !isAbsolute(value) || value !== resolve(value) || value === sep) throw new HandoffError('HANDOFF_ENDPOINT', 'runtime directory override must be a normalized absolute path');
  if (Buffer.byteLength(dir) + 1 + SOCKET_NAME_BYTES > MAX_SOCKET_PATH) throw new HandoffError('HANDOFF_ENDPOINT', 'socket path is too long');
  return dir;
}
export const socketPath = (dir, identity) => {
  const p = join(dir, `h2-${endpointKey(identity)}.sock`);
  if (Buffer.byteLength(p) > MAX_SOCKET_PATH) throw new HandoffError('HANDOFF_ENDPOINT', 'socket path is too long');
  return p;
};

// Verifies (never repairs a foreign directory): real directory, ours, mode 0700, and not reachable through a symlink.
export function assertPrivateDir(dir) {
  let st;
  try { st = lstatSync(dir); } catch { throw new HandoffError('HANDOFF_ENDPOINT', 'handoff directory does not exist'); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff directory is not a real directory');
  if (st.uid !== uid()) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff directory is not owned by the current user');
  if ((st.mode & 0o077) !== 0) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff directory must not be accessible to group/others (mode 0700)');
  let real; try { real = realpathSync(dir); } catch { throw new HandoffError('HANDOFF_ENDPOINT', 'handoff directory cannot be resolved'); }
  if (real !== dir) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff directory path contains a symlink or alias (use the real path)');
  assertSafeAncestors(dir);
}

// Every ancestor must be a real directory owned by root or the current user and not replaceable by others
// (no group/world write unless sticky). Prevents another user from swapping a path component.
export function assertSafeAncestors(dir) {
  for (let p = dirname(dir); ; p = dirname(p)) {
    let st; try { st = lstatSync(p); } catch { throw new HandoffError('HANDOFF_ENDPOINT', 'runtime directory ancestor cannot be inspected'); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new HandoffError('HANDOFF_ENDPOINT', 'runtime directory ancestor is not a real directory');
    if (st.uid !== 0 && st.uid !== uid()) throw new HandoffError('HANDOFF_ENDPOINT', 'runtime directory ancestor has an untrusted owner');
    if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) throw new HandoffError('HANDOFF_ENDPOINT', 'runtime directory ancestor is group/world-writable');
    if (p === dirname(p)) break;
  }
}

export function ensurePrivateDir(dir) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff directory must be an absolute path');
  let exists = true;
  try { lstatSync(dir); } catch { exists = false; }
  if (!exists) { assertSafeAncestors(dir); mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700); } // never recursive: the parent must already be real
  assertPrivateDir(dir);
}

// Returns the lstat of a verified private socket; throws HANDOFF_UNAVAILABLE when absent.
export function assertPrivateSocket(path, { bigint = false } = {}) {
  let st;
  try { st = lstatSync(path, { bigint }); } catch { throw new HandoffError('HANDOFF_UNAVAILABLE', 'handoff custodian is not running (socket not found)'); }
  if (st.isSymbolicLink() || !st.isSocket()) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff endpoint is not a socket');
  if (Number(st.uid) !== uid()) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff socket is not owned by the current user');
  if ((Number(st.mode) & 0o077) !== 0) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff socket must not be accessible to group/others (mode 0600)');
  return st;
}

// ---- minimal, non-payload discovery metadata ------------------------------------------------------------------------
// <runtime-dir>/h2-<key>.json: schema/version, the target identity, the runtime dir, the socket name + inode identity and the
// custodian instance. No payload, handoff id, capability or approval material is ever written. Written atomically
// (O_EXCL temp 0600 + rename); read with O_NOFOLLOW + fstat so a symlink/foreign/loose/hard-linked file is refused.
export const metaPath = (dir, identity) => join(dir, `h2-${endpointKey(identity)}.json`);
const META_KEYS = ['schema', 'version', 'target', 'runtime_dir', 'socket', 'instance_id', 'pid', 'started_at'];

export function writeMetadata(dir, identity, { socket, socketStat, instanceId, startedAt }) {
  const meta = { schema: META_SCHEMA, version: META_VERSION, target: identity, runtime_dir: dir, socket: { name: socket, dev: String(socketStat.dev), ino: String(socketStat.ino) }, instance_id: instanceId, pid: process.pid, started_at: startedAt };
  const final = metaPath(dir, identity); const tmp = join(dir, `.meta-${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
  try { writeSync(fd, JSON.stringify(meta)); } finally { closeSync(fd); }
  try { renameSync(tmp, final); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
  return meta;
}

// Returns the validated metadata, or null when absent. Throws HANDOFF_ENDPOINT for anything suspicious.
export function readMetadata(dir, identity) {
  const path = metaPath(dir, identity); let fd;
  try { fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new HandoffError('HANDOFF_ENDPOINT', 'handoff metadata cannot be opened safely (symlink or unreadable)');
  }
  let raw;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff metadata is not a plain file');
    if (st.uid !== uid()) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff metadata is not owned by the current user');
    if ((st.mode & 0o077) !== 0) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff metadata must not be accessible to group/others (mode 0600)');
    if (st.size > MAX_META_BYTES) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff metadata is too large');
    const buf = Buffer.alloc(st.size); let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
    raw = buf.toString('utf8', 0, off);
  } finally { closeSync(fd); }
  let m; try { m = JSON.parse(raw); } catch { throw new HandoffError('HANDOFF_ENDPOINT', 'handoff metadata is malformed'); }
  const bad = (why) => new HandoffError('HANDOFF_ENDPOINT', `handoff metadata rejected: ${why}`);
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('not an object');
  if (Object.keys(m).sort().join() !== [...META_KEYS].sort().join()) throw bad('unexpected fields');
  if (m.schema !== META_SCHEMA || m.version !== META_VERSION) throw bad('unsupported schema/version');
  if (!sameTarget(m.target, identity)) throw bad('target mismatch');
  if (m.runtime_dir !== dir) throw bad('runtime directory mismatch');
  const expectName = `h2-${endpointKey(identity)}.sock`;
  if (!m.socket || m.socket.name !== expectName || typeof m.socket.dev !== 'string' || typeof m.socket.ino !== 'string') throw bad('socket binding');
  if (typeof m.instance_id !== 'string' || !Number.isInteger(m.pid) || typeof m.started_at !== 'string') throw bad('instance fields');
  return m;
}

// Metadata present but its socket must be exactly the inode the custodian recorded (detects socket substitution).
export function assertSocketMatchesMetadata(meta, st) {
  if (String(st.dev) !== meta.socket.dev || String(st.ino) !== meta.socket.ino) throw new HandoffError('HANDOFF_ENDPOINT', 'handoff socket does not match the recorded custodian identity (substituted?)');
}

export function removeMetadata(dir, identity, instanceId) {
  try { const m = readMetadata(dir, identity); if (m && (instanceId === undefined || m.instance_id === instanceId)) unlinkSync(metaPath(dir, identity)); } catch { /* untrusted or gone: never touch */ }
}
