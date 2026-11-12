// Read-only path confinement. Uses only lstatSync/realpathSync.
// Policy: every input must lie inside the authorized root, and no component
// below the root may be a symlink (symlinks are never followed).
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute, join } from 'node:path';

const inside = (base, target) => {
  const r = relative(base, target);
  return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
};

// Returns null if acceptable, else { rule, message }. Missing paths are
// acceptable here (existence is reported separately).
export function confine(input, root) {
  const target = resolve(input);
  let rootReal;
  try { rootReal = realpathSync(root); } catch { return { rule: 'outside-root', message: 'authorized root is not accessible' }; }
  const lexicalRoot = resolve(root);
  const base = inside(lexicalRoot, target) ? lexicalRoot : inside(rootReal, target) ? rootReal : null;
  if (!base) return { rule: 'outside-root', message: 'path is outside the authorized root' };
  const parts = relative(base, target).split(sep).filter(Boolean);
  let cur = base;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      return { rule: 'unreadable', message: 'path cannot be inspected' };
    }
    if (st.isSymbolicLink()) return { rule: 'symlink', message: 'symlinks are not followed (path component is a symlink)' };
  }
  try { if (!inside(rootReal, realpathSync(target))) return { rule: 'outside-root', message: 'path resolves outside the authorized root' }; } catch { /* missing */ }
  return null;
}
