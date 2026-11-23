// Real macOS platform gate for the production validation isolation. Uses ONLY disposable synthetic commands (/bin/sh, node -e) in a
// throwaway directory: no repository script, provider binary or external network host (loopback only) is involved.
// Where sandbox-exec is unavailable (non-darwin) the tests are explicitly SKIPPED, never passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validationRunner, SANDBOX_EXEC, SANDBOX_PROFILE } from '../adapters/shared/sdd-run/validation.mjs';

const available = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
const skip = available ? false : 'SKIPPED: macOS /usr/bin/sandbox-exec is not available on this platform (isolation NOT verified)';

test('the sandbox profile denies network and all writes except the workspace (static check, runs everywhere)', () => {
  assert.match(SANDBOX_PROFILE, /\(deny network\*\)/);
  assert.match(SANDBOX_PROFILE, /\(deny file-write\*\)/);
  assert.equal((SANDBOX_PROFILE.match(/allow file-write\*/g) ?? []).length, 1);
});

test('real sandbox-exec: writes inside the workspace succeed, writes outside are denied, network is denied', { skip }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dac-sbx-')));
  const ws = join(base, 'ws'); const outside = join(base, 'outside');
  const { mkdirSync } = await import('node:fs'); mkdirSync(ws); mkdirSync(outside);
  const runner = validationRunner();
  const sh = (script) => runner.run({ argv: ['/bin/sh', '-c', script], cwd: ws });
  try {
    // argv has shell metacharacters only because this is a synthetic gate command, not a dac-authorized command
    const inside = sh('echo ok > inside.txt && echo ok > "$HOME/h.txt" && echo ok > "$TMPDIR/t.txt"');
    assert.equal(inside.status, 0, inside.stderr); assert.equal(readFileSync(join(ws, 'inside.txt'), 'utf8'), 'ok\n');
    assert.ok(existsSync(join(ws, '.dac-validation', 'home', 'h.txt')) && existsSync(join(ws, '.dac-validation', 'tmp', 't.txt')));
    const out = sh(`echo bad > '${join(outside, 'x.txt')}'`);
    assert.notEqual(out.status, 0); assert.equal(existsSync(join(outside, 'x.txt')), false, 'write outside the workspace must be denied');
    const real = realpathSync(tmpdir()); const tmpWrite = sh(`echo bad > '${join(real, `dac-sbx-leak-${process.pid}`)}'`);
    assert.notEqual(tmpWrite.status, 0); assert.equal(existsSync(join(real, `dac-sbx-leak-${process.pid}`)), false);
    // network: a loopback TCP connection needs no external host; the sandbox must refuse it
    // a real listener exists in this process, so an unsandboxed connect would succeed (control run proves it)
    const server = createServer((s) => s.end()); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
    const probe = `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))`;
    try {
      const control = await new Promise((r) => execFile(process.execPath, ['-e', probe], (e) => r(e ? e.code : 0)));
      assert.equal(control, 0, 'control: loopback connect works without the sandbox');
      const denied = runner.run({ argv: [process.execPath, '-e', probe], cwd: ws });
      assert.equal(denied.status, 3, `network must be denied (status ${denied.status}: ${denied.stderr})`);
    } finally { server.close(); }
    const env = sh('test -z "$OPENAI_API_KEY" && test "$CI" = 1 && test "$HOME" = "$PWD/.dac-validation/home"');
    assert.equal(env.status, 0, env.stderr);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
