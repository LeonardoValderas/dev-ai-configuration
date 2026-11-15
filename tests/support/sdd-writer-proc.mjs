// Child process used by the real multi-process concurrency test. Runs apply() against a temp target with a
// scripted terminal (the only stand-in: there is no controlling tty under the test runner). The lock, the
// executor and the filesystem are all real and shared between independent OS processes.
// argv: <target> <input.json> <readyFile|-> <goFile|-> <nonceByte>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { apply } from '../../adapters/shared/sdd-writer/writer.mjs';

const [target, inputFile, readyFile, goFile, nonceByte] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const terminal = {
  confirm() {
    if (readyFile !== '-') writeFileSync(readyFile, String(process.pid)); // lock is held right now
    if (goFile !== '-') { const end = Date.now() + 30000; while (!existsSync(goFile) && Date.now() < end) sleep(10); if (!existsSync(goFile)) return false; }
    return true;
  },
};
let out;
try {
  const r = apply({ target, input: JSON.parse(readFileSync(inputFile, 'utf8')), source: () => ({ head: 'a'.repeat(40) }), terminal, random: () => nonceByte.repeat(32) });
  out = { status: r.status, pid: process.pid, files_changed: r.files_changed };
} catch (e) {
  out = { status: e.code === 'LOCKED' ? 'BLOCKED' : 'FAILED', code: e.code, message: e.message, pid: process.pid };
}
console.log(JSON.stringify(out));
