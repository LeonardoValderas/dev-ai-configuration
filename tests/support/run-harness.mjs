// Shared fixtures for the dac implement/review tests. Disposable projects only. The standard source is a throw-away Git copy
// (clean-source gate). NO provider binary is ever executed: runners are simulated in-process, and PATH is pre-loaded with
// tripwire `codex`/`cursor` executables that record any execution attempt.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, cpSync, existsSync, realpathSync, chmodSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../../installer/lib/run.mjs';
import { apply as writerApply } from '../../adapters/shared/sdd-writer/writer.mjs';

export const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dac-run-')));
let n = 0;
export const fresh = (label = 't') => { const d = join(scratch, `${label}-${n++}`); mkdirSync(d, { recursive: true }); return d; };
export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const PID = 'demo-app';

// ---- tripwires: fake provider binaries first on PATH; a marker file proves nothing ever executed them ----
const bin = fresh('tripwire'); export const TRIPWIRE = join(bin, 'executed.log');
for (const name of ['codex', 'cursor', 'cursor-agent']) { const f = join(bin, name); writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${TRIPWIRE}"\nexit 99\n`); chmodSync(f, 0o755); }
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.DAC_CODEX_BIN;

const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1' };
export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const template = fresh('template');
for (const f of execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)) {
  if (!existsSync(join(REPO_ROOT, f))) continue;
  mkdirSync(dirname(join(template, f)), { recursive: true }); cpSync(join(REPO_ROOT, f), join(template, f));
}
git(template, 'init', '-q', '-b', 'main'); git(template, 'add', '-A'); git(template, 'commit', '-q', '-m', 'base');
export const SRC = fresh('src'); cpSync(template, SRC, { recursive: true });
export const dac = (args, cwd, extra = {}) => spawnSync(process.execPath, [join(SRC, 'bin/dac.mjs'), ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });

// ---- SDD documents ----
export const constitution = (pid = PID) => ({ kind: 'sdd-constitution', schema_version: '1.0', project_id: pid, principles: [{ id: 'p-small', statement: 'Ship small, verified changes.' }], constraints: [{ id: 'c-secrets', statement: 'No secrets in the repository.' }] });
export const specify = (pid = PID) => ({
  kind: 'sdd-specify', schema_version: '1.0', project_id: pid,
  requirements: [{ id: 'req-1', statement: 'The library greets a user by name.', acceptance_criteria: ['ac-1', 'ac-2'], open_questions: [] }],
  acceptance_criteria: [{ id: 'ac-1', requirement: 'req-1', statement: 'greet("Ada") returns "Hello, Ada".', verification: 'unit test' }, { id: 'ac-2', requirement: 'req-1', statement: 'greet("") throws.', verification: 'unit test' }],
});
export const task = (o = {}) => ({ id: 't-scaffold', title: 'Scaffold the greeter package', owner: 'backend-expert', change_type: 'code', status: 'planned', requirements: ['req-1'], acceptance_criteria: ['ac-1', 'ac-2'], paths: ['package.json', 'src'], validation_commands: ['node --test'], ...o });
export const projectDoc = (o = {}, pid = PID) => ({
  kind: 'sdd-project', schema_version: '1.0', id: pid, mode: 'lightweight', objective: 'Ship a tiny greeter library', completed_phases: ['specify', 'plan', 'tasks'], skipped_phases: [{ phase: 'constitution', reason: 'covered by the constitution artifact' }],
  scope: { allowed_paths: ['package.json', 'src', 'test', 'README.md', '.gitignore'], prohibited_paths: ['secrets'] },
  requirements: [{ id: 'req-1', statement: 'The library greets a user by name.', acceptance_criteria: ['ac-1', 'ac-2'], open_questions: [] }],
  acceptance_criteria: [{ id: 'ac-1', requirement: 'req-1', statement: 'greet("Ada") returns "Hello, Ada".', verification: 'unit test' }, { id: 'ac-2', requirement: 'req-1', statement: 'greet("") throws.', verification: 'unit test' }],
  decisions: [{ id: 'd-esm', statement: 'Use ES modules.', rationale: 'Simple and standard.', requirements: ['req-1'] }],
  tasks: [task(), task({ id: 't-feature', title: 'Add the feature', paths: ['src', 'test'], depends_on: ['t-scaffold'], validation_commands: [] })],
  risks: [], approvals: [], files_changed: [], validation: { validation_result: 'NOT-RUN', validated_by: '', evidence: [] }, ...o,
});
export const tty = (answer = true) => ({ calls: [], confirm(text, phrase) { this.calls.push({ text, phrase }); return typeof answer === 'function' ? answer(text, phrase) : answer; } });
export const noTty = () => { throw Object.assign(new Error('no tty'), { code: 'TTY_REQUIRED' }); };

export function persist(root, { pid = PID, project = projectDoc({}, pid), only } = {}) {
  const input = { project_id: pid, operation: 'create', constitution: constitution(pid), specify: specify(pid), project };
  if (only) for (const k of ['constitution', 'specify', 'project']) if (!only.includes(k)) delete input[k];
  return writerApply({ target: root, input, source: () => ({ head: 'a'.repeat(40) }), terminal: tty(), random: () => 'ab'.repeat(16) });
}

// born: README committed (+ extra files); unborn: nothing committed. dac init installs the codex provider (real bootstrap).
export function makeProject({ born = true, files = { 'README.md': '# demo\n' }, persistDocs = true, commit = true } = {}) {
  const d = realpathSync(fresh('proj')); git(d, 'init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), c); }
  if (born && commit) { git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init'); }
  const r = dac(['init', '--provider', 'codex', '--package-name', 'demo-pkg'], d);
  if (r.status !== 0) throw new Error(`init failed: ${r.stdout}${r.stderr}`);
  if (persistDocs) persist(d);
  return d;
}

export function snapshot(root, skip = ['.git']) {
  const out = {};
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      if (!rel && skip.includes(name)) continue;
      const p = join(d, name); const r = rel ? `${rel}/${name}` : name; const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(p)}`; else if (st.isDirectory()) { out[r] = 'dir'; walk(p, r); } else out[r] = `${sha(readFileSync(p))}:${st.mode & 0o777}`;
    }
  };
  walk(root, '');
  return out;
}

// ---- simulated runners (never spawn anything) ----
const profile = (role, network = false, model) => ({ ...(model === undefined ? {} : { model }), id: `sim-${role}`, role, sandbox: role === 'implement' ? 'workspace-write' : 'read-only', approval: role === 'implement' ? 'on-request' : 'never', mcp: 'none', network: role === 'implement' ? network : false, bypass: false, argv: ['sim', role] });
export const okResult = (files = [], o = {}) => ({ schema_version: '1.0', kind: 'result', execution_status: 'COMPLETE', validation_result: 'PASS', files_changed: files, evidence: [{ description: 'simulated run', command: 'node --test', output_summary: '1 passed' }], warnings: [], unresolved_blockers: [], ...o });
export function implRunner(effect = () => {}, result = null, o = {}) {
  const r = { id: o.id ?? 'sim-implement', role: o.role ?? 'implement', calls: [], describe: ({ network, model } = {}) => ({ ...profile('implement', network, model), ...(o.profile ?? {}) }),
    async run(args) { r.calls.push(args); await effect(args.cwd, args); return { result: typeof result === 'function' ? result(args.cwd) : result ?? okResult() }; } };
  return r;
}
export function reviewRunner(effect = () => {}, result = null, o = {}) {
  const r = { id: o.id ?? 'sim-review', role: o.role ?? 'review', calls: [], describe: ({ model } = {}) => ({ ...profile('review', false, model), ...(o.profile ?? {}) }),
    async run(args) { r.calls.push(args); await effect(args.cwd, args); return { result: typeof result === 'function' ? result(args) : result ?? okResult([]) }; } };
  return r;
}
export const write = (cwd, rel, text, mode) => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), text); if (mode) chmodSync(join(cwd, rel), mode); };
export const quiet = () => { const out = []; return { out, log: (s) => out.push(String(s)) }; };

// ---- shared drivers for the implement/review tests ----
import { implementTask } from '../../adapters/shared/sdd-run/implement.mjs';
import { reviewTask } from '../../adapters/shared/sdd-run/review.mjs';
import { listRuns, taskDir } from '../../adapters/shared/sdd-run/store.mjs';
export const state = () => fresh('state');
export const SCAFFOLD = (cwd) => { write(cwd, 'package.json', '{"name":"demo"}\n'); write(cwd, 'src/index.js', 'export const greet = (n) => `Hello, ${n}`;\n'); };
export const ok = (files = ['package.json', 'src/index.js']) => okResult(files);
export async function impl(root, { taskId = 't-scaffold', runner = implRunner(SCAFFOLD, ok()), terminal = tty(), st = state(), flags = {}, extra = {} } = {}) {
  const q = quiet();
  try { const code = await implementTask({ root, taskId, flags, deps: { terminal, implementRunner: runner, stateDir: st, log: q.log, ...extra } }); return { code, out: q.out.join('\n'), st, runner, terminal }; } catch (e) { return { error: e, code: e.code, out: q.out.join('\n'), st, runner, terminal }; }
}
// Simulated independent-validation runner: never spawns anything. `outcome(argv, call)` returns a partial runner result.
export function validationSim(outcome = () => ({}), o = {}) {
  const r = { id: o.id ?? 'sim-validate', role: o.role ?? 'validate', calls: [],
    describe: () => ({ id: r.id, role: 'validate', kind: 'simulated', shell: false, bypass: false, ...(o.profile ?? {}) }),
    async run(args) { r.calls.push(args); const x = await outcome(args.argv, args, r.calls.length); return x === null ? null : { argv: args.argv, status: 0, signal: null, error: null, stdout: `sim stdout: ${args.command}\n`, stderr: '', ...x }; } };
  return r;
}
export async function review(root, st, { taskId = 't-scaffold', runner = reviewRunner(), flags = {}, validator = validationSim() } = {}) {
  const q = quiet();
  try { const code = await reviewTask({ root, taskId, flags, deps: { reviewRunner: runner, validationRunner: validator, stateDir: st, log: q.log } }); return { code, out: q.out.join('\n'), runner, validator }; } catch (e) { return { error: e, code: e.code, out: q.out.join('\n'), runner, validator }; }
}
export const runs = (root, st, taskId = 't-scaffold') => listRuns(taskDir(st, root, PID, taskId));
export const branches = (root) => git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads').trim().split('\n');
export const worktreeCount = (root) => git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
export const stateEntries = (st) => (existsSync(st) ? readdirSync(st) : []);
export const BASE_FILES = { 'README.md': '# demo\n', 'src/old.js': 'export const old = 1;\n', 'src/keep.js': 'export const keep = 1;\n', 'package.json': '{"name":"base"}\n', '.gitignore': '*.log\n' };
