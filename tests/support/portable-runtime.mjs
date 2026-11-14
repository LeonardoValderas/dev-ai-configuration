// No credentials or model calls, including when ambient credentials are present.
// Only two fixed help/version arguments are accepted. No unsandboxed fallback.
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const sandbox = '/usr/bin/sandbox-exec';
const q = JSON.stringify;
export function available() {
  if (process.platform !== 'darwin' || !existsSync(sandbox)) return false;
  return spawnSync(sandbox, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 10000 }).status === 0;
}
export function environment(base) {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(base, 'home'), CODEX_HOME: join(base, 'codex'), CURSOR_CONFIG_DIR: join(base, 'cursor'), XDG_CONFIG_HOME: join(base, 'config'), XDG_CACHE_HOME: join(base, 'cache'), XDG_DATA_HOME: join(base, 'data'), XDG_STATE_HOME: join(base, 'state'), TMPDIR: join(base, 'tmp'), TMP: join(base, 'tmp'), TEMP: join(base, 'tmp'), NO_COLOR: '1' };
}
export function profile(base, homes) {
  return ['(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)', `(allow file-write* (subpath ${q(base)}) (literal "/dev/null"))`, ...homes.flatMap((h) => ['.claude', '.codex', '.cursor', '.claude.json'].flatMap((name) => [`(deny file-read* (subpath ${q(join(h, name))}))`, `(deny file-write* (subpath ${q(join(h, name))}))`]))].join('\n');
}
export function invocation(cmd, args) {
  if (!['codex', 'agent'].includes(cmd) || args.length !== 1 || !['--help', '--version'].includes(args[0])) throw new Error('BLOCKED: only unauthenticated help/version probes are allowed');
}
function snapshot(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
    const p = join(e.parentPath ?? e.path, e.name);
    return [p, createHash('sha256').update(readFileSync(p)).digest('hex')];
  }).sort();
}
export function runProbe(cmd, args, setup = () => {}) {
  invocation(cmd, args);
  if (!available()) throw new Error('BLOCKED: macOS sandbox unavailable; no fallback');
  // The real profiles are never inspected (explicit task prohibition). Synthetic protected
  // profiles are snapshotted and exercise the same policy. Real roots are denied by the OS.
  const base = realpathSync(mkdtempSync('/tmp/dac-native-runtime-'));
  const decoy = realpathSync(mkdtempSync('/tmp/dac-native-protected-'));
  const env = environment(base);
  const ws = join(base, 'ws');
  try {
    for (const [k, v] of Object.entries(env)) if (!['PATH', 'NO_COLOR'].includes(k)) mkdirSync(v, { recursive: true });
    mkdirSync(ws);
    for (const name of ['.claude', '.codex', '.cursor']) { mkdirSync(join(decoy, name)); writeFileSync(join(decoy, name, 'profile'), 'synthetic protected profile'); }
    writeFileSync(join(decoy, '.claude.json'), '{}');
    const sb = profile(base, [userInfo().homedir, decoy]);
    const run = (exe, argv) => spawnSync(sandbox, ['-p', sb, exe, ...argv], { cwd: ws, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    const before = snapshot(decoy);
    // Prove protected reads and external writes fail, while disposable writes succeed.
    for (const name of ['.claude', '.codex', '.cursor']) {
      const file = join(decoy, name, 'profile');
      if (run('/bin/cat', [file]).status === 0 || run('/usr/bin/touch', [file]).status === 0) throw new Error('BLOCKED: protected profile isolation failed');
    }
    if (run('/usr/bin/touch', [join(base, 'canary')]).status !== 0) throw new Error('BLOCKED: disposable write control failed');
    // Exercise network denial without reaching an external host: bind a local TCP socket.
    const net = run(process.execPath, ['-e', "require('net').createServer().on('error',()=>process.exit(0)).listen(0,'127.0.0.1',()=>process.exit(1))"]);
    if (net.status !== 0) throw new Error('BLOCKED: network denial self-test failed');
    setup(ws);
    const result = run(cmd, args);
    if (JSON.stringify(snapshot(decoy)) !== JSON.stringify(before)) throw new Error('protected profile changed');
    return { ...result, evidence: 'CLI integration: help/version only', protectedProfiles: 'synthetic snapshots unchanged; real profiles OS-denied, never inspected' };
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(decoy, { recursive: true, force: true }); }
}
