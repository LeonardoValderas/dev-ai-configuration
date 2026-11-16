// Installed-runtime variant of identity.mjs (distributed to .dac/runtime/sdd-handoff/identity.mjs by the Claude Code adapter).
// The stateless MCP proxy only needs the real-path + device/inode identity to find its endpoint; it has no standards checkout.
// The custodian and the writer (which DO run from the standards checkout) keep the stricter resolveTarget() checks in identity.mjs,
// so a wrong target here can only fail to match a custodian. Both variants MUST produce the same identity for the same directory
// (regression-tested).
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const fail = (message) => Object.assign(new Error(message), { code: 'TARGET' });

export function targetIdentity(target) {
  if (typeof target !== 'string' || target === '') throw fail('target must be a directory path');
  const abs = resolve(target);
  let st;
  try { st = lstatSync(abs); } catch { throw fail('target directory does not exist'); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw fail('target must be a real directory (symlinks are not followed)');
  const root = realpathSync(abs);
  const s = statSync(root, { bigint: true });
  return { realpath: root, device: s.dev.toString(), inode: s.ino.toString() };
}

export const endpointKey = (id) => createHash('sha256').update(`dac-sdd-handoff-v2\0${id.realpath}\0${id.device}\0${id.inode}`).digest('hex').slice(0, 20);
