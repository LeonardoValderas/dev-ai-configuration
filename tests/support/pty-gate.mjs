// macOS gate: the real-PTY tests of the SDD artifact writer MUST execute. Unlike `npm test` (where they are an
// explicit Node SKIP when python3/pty is missing), this gate fails if python3/pty is unavailable, if any PTY test is
// skipped, or if fewer than the expected PTY tests ran. It does not install anything.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED = 6; // writer tests 22, 22b, 22c + handoff PoC test 13 + dac implement authorization (cancel, approve)
const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [join(dir, 'sdd-artifact-writer.test.mjs'), join(dir, 'sdd-handoff.test.mjs'), join(dir, 'dac-implement-pty.test.mjs')];
const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=PTY', ...files], { encoding: 'utf8', env: { ...process.env, DAC_REQUIRE_PTY: '1' } });
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
const num = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout ?? '')?.[1] ?? NaN);
const pass = num('pass'), fail = num('fail'), skipped = num('skipped');
if (r.status !== 0 || fail !== 0 || skipped !== 0 || !(pass >= EXPECTED)) {
  console.error(`PTY GATE BLOCKED: pass=${pass} fail=${fail} skipped=${skipped}; expected >= ${EXPECTED} executed PTY tests and 0 skipped.`);
  process.exit(1);
}
console.log(`PTY GATE OK: ${pass} real PTY tests executed, 0 skipped.`);
