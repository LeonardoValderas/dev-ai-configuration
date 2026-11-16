import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveTarget } from '../apply.mjs';

// Same shape as the writer's plan.target, so the custodian binding and the plan/authorization binding agree.
export function targetIdentity(target) {
  const root = resolveTarget(target);
  const st = statSync(root, { bigint: true });
  return { realpath: root, device: st.dev.toString(), inode: st.ino.toString() };
}

// Deterministic endpoint key from the real target identity (not secret, reveals no payload content).
export const endpointKey = (id) => createHash('sha256').update(`dac-sdd-handoff-v2\0${id.realpath}\0${id.device}\0${id.inode}`).digest('hex').slice(0, 20);
