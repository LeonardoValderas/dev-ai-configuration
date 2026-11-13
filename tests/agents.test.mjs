import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePaths, REPO_ROOT } from '../installer/lib/run.mjs';

const AGENTS_DIR = join(REPO_ROOT, 'standards', 'manifests', 'agents');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const catalog = readJson(join(AGENTS_DIR, 'agent-catalog.json'));
const manifests = readdirSync(AGENTS_DIR).filter((n) => n.endsWith('.json') && n !== 'agent-catalog.json').map((n) => readJson(join(AGENTS_DIR, n)));
const byId = new Map(manifests.map((m) => [m.id, m]));
const ABS_UNIX = '/' + 'home' + '/synthetic-user';

// Copy the real catalog to a scratch dir, let the caller mutate it, validate.
function scenario(mutate) {
  const tmp = mkdtempSync(join(tmpdir(), 'dac-agents-'));
  cpSync(AGENTS_DIR, tmp, { recursive: true });
  const edit = (file, fn) => { const p = join(tmp, file); const d = readJson(p); fn(d); writeFileSync(p, JSON.stringify(d, null, 2)); };
  const editText = (file, fn) => { const p = join(tmp, file); writeFileSync(p, fn(readFileSync(p, 'utf8'))); };
  try {
    mutate({ edit, editText, tmp });
    return validatePaths([tmp], { root: tmp }).errors;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
const has = (errors, code, rule) => errors.some((e) => e.code === code && (rule === undefined || e.rule === rule));
const expectError = (name, mutate, code, rule) => test(`negative: ${name}`, () => {
  const errors = scenario(mutate);
  assert.ok(has(errors, code, rule), `expected ${code}${rule ? `[${rule}]` : ''}, got ${JSON.stringify(errors)}`);
});

// ---- positive ---------------------------------------------------------------
test('real agent catalog and manifests validate cleanly', () => {
  assert.deepEqual(scenario(() => {}), []);
});

const PRIMARY = ['repo-analyst', 'technical-planner', 'prompt-engineer', 'site-analyst', 'frontend-expert', 'backend-expert', 'kmp-expert', 'e2e-tester'];
const OPTIONAL = ['code-reviewer', 'payment-integration'];
const REDUNDANT = { 'backend-architect': 'backend-expert', 'frontend-developer': 'frontend-expert' };

test('catalog is exactly the 12 original agents with the exact classification', () => {
  const ids = (c) => catalog.agents.filter((a) => a.classification === c).map((a) => a.id);
  assert.equal(catalog.agents.length, 12);
  assert.deepEqual(ids('primary'), PRIMARY);
  assert.deepEqual(ids('optional'), OPTIONAL);
  assert.deepEqual(ids('redundant'), Object.keys(REDUNDANT));
  for (const [id, target] of Object.entries(REDUNDANT)) assert.equal(catalog.agents.find((a) => a.id === id).superseded_by, target, id);
  for (const a of catalog.agents) assert.equal(a.provenance, 'original-agent-file', a.id);
  assert.deepEqual(catalog.expected, { total: 12, primary: 8 });
});

test('exactly 10 manifests and 10 instruction files exist, none for redundant agents', () => {
  assert.deepEqual([...byId.keys()].sort(), [...PRIMARY, ...OPTIONAL].sort());
  const md = readdirSync(AGENTS_DIR).filter((n) => n.endsWith('.md')).sort();
  assert.deepEqual(md, [...PRIMARY, ...OPTIONAL].map((i) => `${i}.md`).sort());
});

test('functions: advisors read-only, implementers write, code-reviewer reviews', () => {
  for (const id of ['repo-analyst', 'technical-planner', 'prompt-engineer', 'site-analyst']) assert.equal(byId.get(id).function, 'advisor', id);
  for (const id of ['frontend-expert', 'backend-expert', 'kmp-expert', 'e2e-tester', 'payment-integration']) assert.equal(byId.get(id).function, 'implementer', id);
  assert.equal(byId.get('code-reviewer').function, 'reviewer');
});

test('validation stays independent: code-reviewer cannot run validation and no agent reviews itself', () => {
  const r = byId.get('code-reviewer');
  assert.ok(!r.permissions.shell_commands.some((c) => /^npm\b/.test(c)));
  assert.ok(!r.permissions.tools.some((t) => /^(Write|Edit|MultiEdit|NotebookEdit|Bash)/i.test(t)));
  for (const ref of r.independent_of) assert.equal(byId.get(ref)?.function, 'implementer', ref);
  assert.deepEqual([...r.independent_of].sort(), ['backend-expert', 'e2e-tester', 'frontend-expert', 'kmp-expert', 'payment-integration']);
  for (const m of manifests) assert.ok(!(m.independent_of ?? []).includes(m.id), m.id);
});

test('every non-redundant catalog agent has a manifest and instructions; redundant ones have none', () => {
  for (const e of catalog.agents) {
    const m = byId.get(e.id);
    if (e.classification === 'redundant') {
      assert.equal(m, undefined, e.id);
      assert.ok(catalog.agents.find((p) => p.id === e.superseded_by)?.classification === 'primary', e.id);
    } else {
      assert.ok(m, e.id);
      assert.ok(existsSync(join(AGENTS_DIR, m.instructions_path)), e.id);
    }
  }
});

test('manifests are tied to the common task and result contracts with activation and limits', () => {
  for (const m of manifests) {
    assert.deepEqual(m.contracts, { task: 'task-contract', result: 'result' }, m.id);
    assert.ok(m.activation.length >= 1, m.id);
    assert.ok(Number.isInteger(m.limits.max_files_changed), m.id);
    assert.equal(m.permissions.production_access, 'none', m.id);
    assert.notEqual(m.permissions.permission_mode, 'bypassPermissions', m.id);
  }
});

test('code-reviewer is strictly read-only; reviewers and validators are independent of implementers', () => {
  const r = byId.get('code-reviewer');
  assert.equal(r.read_only, true);
  assert.equal(r.function, 'reviewer');
  assert.equal(r.limits.max_files_changed, 0);
  assert.equal(r.permissions.writable_paths, undefined);
  assert.deepEqual(r.permissions.tools, ['Read', 'Grep', 'Glob']);
  for (const m of manifests.filter((x) => x.function === 'reviewer' || x.function === 'validator')) {
    assert.equal(m.read_only, true, m.id);
    assert.ok(m.independent_of.length > 0 && !m.independent_of.includes(m.id), m.id);
    for (const ref of m.independent_of) assert.equal(byId.get(ref)?.function, 'implementer', `${m.id} -> ${ref}`);
  }
});

test('portable catalog has no OpenClaw runtime dependency and no machine-specific paths', () => {
  const dirs = [join(REPO_ROOT, 'standards'), join(REPO_ROOT, 'compatibility'), join(REPO_ROOT, '.github')];
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); lstatSync(p).isDirectory() ? walk(p) : files.push(p); } };
  dirs.forEach(walk);
  assert.ok(files.length > 20);
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /open[-_ ]?claw/i, f);
    assert.doesNotMatch(t, new RegExp(['/Us', 'ers/'].join('')), f);
    assert.doesNotMatch(t, new RegExp(['/ho', 'me/'].join('')), f);
  }
});

test('validation of the catalog does not need any OpenClaw environment', () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => /openclaw/i.test(k)));
  for (const k of Object.keys(saved)) delete process.env[k];
  try { assert.deepEqual(validatePaths([AGENTS_DIR]).errors, []); } finally { Object.assign(process.env, saved); }
});

// ---- CI workflow ---------------------------------------------------------------
test('CI workflow: PR-to-main only, least privilege, pinned actions, no secrets or publishing', () => {
  const t = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'pr-validation.yml'), 'utf8');
  assert.match(t, /^on:\n  pull_request:\n    branches: \[main\]\n/m);
  assert.doesNotMatch(t, /^\s+(push|schedule|workflow_dispatch|pull_request_target|release):/m);
  assert.match(t, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(t, /secrets\.|npm ci|npm install|npm publish|deploy|id-token|write/i);
  const uses = [...t.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 1);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, u);
  assert.deepEqual(uses, [
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  ]);
  assert.match(t, /node-version: 20$/m);
  assert.match(t, /run: npm test$/m);
  assert.match(t, /run: npm run validate$/m);
});

// ---- negative: permissions ------------------------------------------------------
expectError('code-reviewer gains a write tool', ({ edit }) => edit('code-reviewer.json', (d) => d.permissions.tools.push('Write')), 'AGENT_POLICY', 'read-only-violation');
expectError('code-reviewer gains an Edit tool', ({ edit }) => edit('code-reviewer.json', (d) => d.permissions.tools.push('Edit')), 'AGENT_POLICY', 'read-only-violation');
expectError('code-reviewer gains a Bash tool', ({ edit }) => edit('code-reviewer.json', (d) => d.permissions.tools.push('Bash(git diff:*)')), 'AGENT_POLICY', 'read-only-violation');
expectError('code-reviewer gains writable_paths', ({ edit }) => edit('code-reviewer.json', (d) => { d.permissions.writable_paths = ['src/**']; }), 'AGENT_POLICY', 'read-only-violation');
expectError('code-reviewer gains a mutating shell command', ({ edit }) => edit('code-reviewer.json', (d) => d.permissions.shell_commands.push('git commit')), 'AGENT_POLICY', 'read-only-violation');
expectError('code-reviewer gains npm test (only validators may run it)', ({ edit }) => edit('code-reviewer.json', (d) => d.permissions.shell_commands.push('npm test')), 'AGENT_POLICY', 'read-only-violation');
expectError('code-reviewer is no longer read_only', ({ edit }) => edit('code-reviewer.json', (d) => { d.read_only = false; }), 'AGENT_POLICY', 'code-reviewer-read-only');
expectError('code-reviewer may change files', ({ edit }) => edit('code-reviewer.json', (d) => { d.limits.max_files_changed = 3; }), 'AGENT_POLICY', 'limits');
expectError('advisor function without read_only', ({ edit }) => edit('repo-analyst.json', (d) => { d.read_only = false; }), 'AGENT_POLICY', 'read-only-required');
expectError('bypassPermissions mode', ({ edit }) => edit('backend-expert.json', (d) => { d.permissions.permission_mode = 'bypassPermissions'; }), 'DANGEROUS_PERMISSION', 'bypass-permissions');
expectError('production mutate access', ({ edit }) => edit('backend-expert.json', (d) => { d.permissions.production_access = 'mutate'; }), 'DANGEROUS_PERMISSION', 'production-mutation');
expectError('production read-only access on a catalog agent', ({ edit }) => edit('backend-expert.json', (d) => { d.permissions.production_access = 'read-only'; }), 'AGENT_POLICY', 'production-access');
expectError('force push', ({ edit }) => edit('backend-expert.json', (d) => d.permissions.shell_commands.push('git push --force')), 'DANGEROUS_PERMISSION', 'force-push');
expectError('broad write path', ({ edit }) => edit('backend-expert.json', (d) => d.permissions.writable_paths.push('*')), 'DANGEROUS_PERMISSION', 'broad-path-grant');
expectError('implementer without scoped writable_paths', ({ edit }) => edit('backend-expert.json', (d) => { delete d.permissions.writable_paths; }), 'AGENT_POLICY', 'missing-portable-field');

// ---- negative: contracts and required fields ---------------------------------------
expectError('catalog agent missing contracts', ({ edit }) => edit('backend-expert.json', (d) => { delete d.contracts; }), 'AGENT_POLICY', 'missing-portable-field');
expectError('catalog agent missing activation', ({ edit }) => edit('backend-expert.json', (d) => { delete d.activation; }), 'AGENT_POLICY', 'missing-portable-field');
expectError('catalog agent missing limits', ({ edit }) => edit('backend-expert.json', (d) => { delete d.limits; }), 'AGENT_POLICY', 'missing-portable-field');
expectError('unknown task contract reference', ({ edit }) => edit('backend-expert.json', (d) => { d.contracts.task = 'custom-task'; }), 'SCHEMA_INVALID_VALUE');
expectError('unknown result contract reference', ({ edit }) => edit('backend-expert.json', (d) => { d.contracts.result = 'free-text'; }), 'SCHEMA_INVALID_VALUE');
expectError('empty activation list', ({ edit }) => edit('backend-expert.json', (d) => { d.activation = []; }), 'SCHEMA_CONSTRAINT');

// ---- negative: references and independence -----------------------------------------
expectError('independent_of unknown agent', ({ edit }) => edit('code-reviewer.json', (d) => d.independent_of.push('ghost-agent')), 'MISSING_REFERENCE', 'component');
expectError('independent_of itself', ({ edit }) => edit('code-reviewer.json', (d) => d.independent_of.push('code-reviewer')), 'AGENT_POLICY', 'independence');
expectError('independent_of a non-implementer', ({ edit }) => edit('code-reviewer.json', (d) => d.independent_of.push('repo-analyst')), 'AGENT_POLICY', 'independence');
expectError('reviewer without independent_of', ({ edit }) => edit('code-reviewer.json', (d) => { delete d.independent_of; }), 'AGENT_POLICY', 'independence');
expectError('implementer declaring independent_of', ({ edit }) => edit('backend-expert.json', (d) => { d.independent_of = ['kmp-expert']; }), 'AGENT_POLICY', 'independence');
expectError('skill reference to an undefined skill', ({ edit }) => edit('backend-expert.json', (d) => { d.skills = ['no-such-skill']; }), 'MISSING_REFERENCE', 'component');
expectError('missing instructions file', ({ tmp }) => rmSync(join(tmp, 'repo-analyst.md')), 'MISSING_REFERENCE', 'instructions-file');
expectError('catalog entry without manifest', ({ tmp }) => { rmSync(join(tmp, 'payment-integration.json')); rmSync(join(tmp, 'payment-integration.md')); }, 'MISSING_REFERENCE', 'catalog-manifest');
expectError('manifest not listed in the catalog', ({ edit }) => edit('agent-catalog.json', (d) => { d.agents = d.agents.filter((a) => a.id !== 'payment-integration'); d.expected.total = 11; }), 'AGENT_POLICY', 'orphan-manifest');
expectError('redundant agent with a manifest', ({ edit }) => edit('agent-catalog.json', (d) => { d.agents.find((a) => a.id === 'payment-integration').classification = 'redundant'; d.agents.find((a) => a.id === 'payment-integration').superseded_by = 'backend-expert'; }), 'AGENT_POLICY', 'redundant-has-manifest');
expectError('redundant agent superseded by an unknown agent', ({ edit }) => edit('agent-catalog.json', (d) => { d.agents.find((a) => a.id === 'backend-architect').superseded_by = 'ghost-agent'; }), 'MISSING_REFERENCE', 'catalog-superseded-by');
expectError('redundant agent without superseded_by', ({ edit }) => edit('agent-catalog.json', (d) => { delete d.agents.find((a) => a.id === 'frontend-developer').superseded_by; }), 'AGENT_POLICY', 'classification');
expectError('superseded_by on a non-redundant agent', ({ edit }) => edit('agent-catalog.json', (d) => { d.agents.find((a) => a.id === 'payment-integration').superseded_by = 'backend-expert'; }), 'AGENT_POLICY', 'classification');
expectError('catalog total does not match', ({ edit }) => edit('agent-catalog.json', (d) => { d.expected.total = 13; }), 'AGENT_POLICY', 'catalog-count');
expectError('catalog primary count does not match', ({ edit }) => edit('agent-catalog.json', (d) => { d.expected.primary = 7; }), 'AGENT_POLICY', 'catalog-count');
expectError('duplicate catalog entry', ({ edit }) => edit('agent-catalog.json', (d) => d.agents.push({ ...d.agents[0] })), 'DUPLICATE_ID');
expectError('invalid classification value', ({ edit }) => edit('agent-catalog.json', (d) => { d.agents[0].classification = 'essential'; }), 'SCHEMA_INVALID_VALUE');
expectError('code-reviewer reclassified as redundant', ({ edit }) => edit('agent-catalog.json', (d) => { const e = d.agents.find((a) => a.id === 'code-reviewer'); e.classification = 'redundant'; e.superseded_by = 'backend-expert'; }), 'AGENT_POLICY', 'code-reviewer-read-only');
expectError('code-reviewer removed from the catalog', ({ edit }) => edit('agent-catalog.json', (d) => { d.agents = d.agents.filter((a) => a.id !== 'code-reviewer'); d.expected.total = 11; }), 'AGENT_POLICY', 'code-reviewer-read-only');
expectError('redundant agent gains a manifest-less supersede of a non-primary', ({ edit }) => edit('agent-catalog.json', (d) => { d.agents.find((a) => a.id === 'frontend-developer').superseded_by = 'payment-integration'; }), 'MISSING_REFERENCE', 'catalog-superseded-by');

// ---- negative: machine-specific paths and OpenClaw coupling -------------------------
expectError('absolute instructions_path', ({ edit }) => edit('repo-analyst.json', (d) => { d.instructions_path = ABS_UNIX + '/repo-analyst.md'; }), 'ABSOLUTE_PATH');
expectError('absolute writable path', ({ edit }) => edit('backend-expert.json', (d) => d.permissions.writable_paths.push(ABS_UNIX + '/src')), 'ABSOLUTE_PATH');
expectError('machine path in description', ({ edit }) => edit('repo-analyst.json', (d) => { d.description = `Reads ${ABS_UNIX}/notes`; }), 'ABSOLUTE_PATH');
expectError('path traversal in instructions_path', ({ edit }) => edit('repo-analyst.json', (d) => { d.instructions_path = '../repo-analyst.md'; }), 'PATH_TRAVERSAL');
expectError('OpenClaw reference in a manifest', ({ edit }) => edit('repo-analyst.json', (d) => { d.description = 'Runs through the OpenClaw gateway'; }), 'RUNTIME_COUPLING', 'openclaw');
expectError('OpenClaw reference in instructions', ({ editText }) => editText('repo-analyst.md', (t) => t + '\nRequires openclaw to run.\n'), 'RUNTIME_COUPLING', 'openclaw');
expectError('OpenClaw reference in the catalog', ({ edit }) => edit('agent-catalog.json', (d) => { d.agents[0].rationale = 'Dispatched by open-claw'; }), 'RUNTIME_COUPLING', 'openclaw');
expectError('provider-specific field in a manifest', ({ edit }) => edit('repo-analyst.json', (d) => { d.claude_code = { model: 'x' }; }), 'SCHEMA_UNKNOWN_FIELD');
