// Real-PTY tests for the dac implement pre-implementation authorization: python3 pty.fork gives the child a controlling
// terminal, so the REAL openTrustedTerminal() (/dev/tty) is used. The implementation runner is still simulated in-process; no
// Codex/Cursor binary exists in this path. Explicit SKIP when python3/pty is unavailable; `npm run test:pty-gate` makes that a failure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../installer/lib/run.mjs';
import * as H from './support/run-harness.mjs';
import { makeProject, runs, BASE_FILES, PID, git } from './support/run-harness.mjs';

after(() => { rmSync(H.scratch, { recursive: true, force: true }); });
const REQUIRE_PTY = process.env.DAC_REQUIRE_PTY === '1';
const HARNESS = `import os,pty,sys,select,time
node,code,mode=sys.argv[1:4]
pid,fd=pty.fork()
if pid==0:
    os.execv(node,[node,'--input-type=module','-e',code])
out=b'';end=time.time()+40;stage=0;t0=0
while time.time()<end:
    r,_,_=select.select([fd],[],[],0.05)
    if r:
        try: d=os.read(fd,65536)
        except OSError: break
        if not d: break
        out+=d
    txt=out.decode('utf8','replace')
    if stage==0 and 'Type exactly "' in txt and '" within' in txt:
        phrase=txt.split('Type exactly "',1)[1].split('" within',1)[0]
        t0=time.time();stage=1
    if stage==1 and time.time()>=t0+0.2:
        os.write(fd,(phrase if mode=='good' else 'nope').encode()+b'\\r'); stage=2
os.waitpid(pid,0)
sys.stdout.write(out.decode('utf8','replace'))`;
let probe;
const unavailable = () => {
  if (probe === undefined) { const r = spawnSync('python3', ['-I', '-c', 'import os,pty\nos.close(pty.openpty()[0])'], { encoding: 'utf8', timeout: 10000 }); probe = r.error || r.status !== 0 ? `python3/pty unavailable (${r.error?.code ?? `exit ${r.status}`})` : ''; }
  return probe;
};
const ptyTest = (name, fn) => test(name, { skip: !REQUIRE_PTY && unavailable() ? unavailable() : false }, (t) => { if (unavailable()) assert.fail(`mandatory PTY prerequisite missing: ${unavailable()}`); return fn(t); });
const IMPLEMENT = pathToFileURL(join(REPO_ROOT, 'adapters/shared/sdd-run/implement.mjs')).href;

function ptyRun(root, st, mode) {
  const child = `import {implementTask} from ${JSON.stringify(IMPLEMENT)}; import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
const runner={id:'sim-implement',role:'implement',describe:()=>({id:'sim-implement',role:'implement',sandbox:'workspace-write',approval:'on-request',mcp:'none',network:false,bypass:false,argv:['sim']}),
 async run({cwd}){ mkdirSync(join(cwd,'src'),{recursive:true}); writeFileSync(join(cwd,'src/index.js'),'export const a=1;\\n'); writeFileSync(join(cwd,'package.json'),'{}\\n');
  return {result:{schema_version:'1.0',kind:'result',execution_status:'COMPLETE',validation_result:'PASS',files_changed:['package.json','src/index.js'],evidence:[{description:'sim'}],warnings:[],unresolved_blockers:[]}}; }};
let o; try { o={code:await implementTask({root:${JSON.stringify(root)},taskId:'t-scaffold',deps:{implementRunner:runner,stateDir:${JSON.stringify(st)}}})}; } catch(e){ o={code:e.code}; }
console.log('RESULT '+JSON.stringify(o));`;
  const r = spawnSync('python3', ['-I', '-c', HARNESS, process.execPath, child, mode], { encoding: 'utf8', timeout: 60000 });
  const m = /RESULT (\{.*\})/.exec(r.stdout ?? '');
  assert.ok(m, `the PTY child produced no result (harness failure, not a skip): ${r.stderr}${r.stdout}`);
  return { ...JSON.parse(m[1]), transcript: r.stdout };
}

ptyTest('PTY: dac implement asks on the real /dev/tty, shows the exact contract, and a typed wrong phrase cancels with nothing created', () => {
  const root = makeProject({ files: BASE_FILES }); const st = H.state(); const head = git(root, 'rev-parse', 'HEAD').trim();
  const o = ptyRun(root, st, 'bad');
  assert.equal(o.code, 'APPROVAL_DENIED', o.transcript);
  for (const needle of ['pre-implementation authorization requested', 't-scaffold', head.slice(0, 12), 'package.json, src', 'node --test', 'authorization digest']) assert.ok(o.transcript.includes(needle), needle);
  assert.deepEqual(runs(root, st), []); assert.deepEqual(H.stateEntries(st), [], 'nothing written to the run state');
  assert.deepEqual(git(root, 'for-each-ref', '--format=%(refname)').trim().split('\n').filter((b) => b.includes('dac/')), []);
});

ptyTest('PTY: typing the exact phrase on the real terminal authorizes; the simulated run is audited and retained (control for the cancel test)', () => {
  const root = makeProject({ files: BASE_FILES }); const st = H.state();
  const o = ptyRun(root, st, 'good');
  assert.equal(o.code, 0, o.transcript);
  const [run] = runs(root, st); assert.equal(run.outcome.status, 'READY_FOR_REVIEW'); assert.equal(run.audit.status, 'PASS');
  assert.equal(existsSync(H.TRIPWIRE), false);
});
