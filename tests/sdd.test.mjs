import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readdirSync, readFileSync, writeFileSync, rmSync, lstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validatePaths, REPO_ROOT } from '../installer/lib/run.mjs';
import { SPEC_KIT_PIN, PHASES } from '../installer/lib/sdd.mjs';

const SDD = join(REPO_ROOT, 'standards', 'sdd');
const AGENTS = join(REPO_ROOT, 'standards', 'manifests', 'agents');
const FIX = join(REPO_ROOT, 'tests', 'sdd-fixtures');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const workflow = readJson(join(SDD, 'sdd-workflow.json'));
const agentMap = readJson(join(SDD, 'sdd-agent-map.json'));
const integration = readJson(join(SDD, 'spec-kit-integration.json'));
const mode = (id) => workflow.modes.find((m) => m.id === id);

const FULL = 'fx/projects/project-full.json';
const LIGHT = 'fx/projects/project-lightweight.json';
const HOT = 'fx/projects/project-hotfix.json';
const PLAN = 'fx/projects/project-planning.json';
const WF = 'sdd/sdd-workflow.json';
const MAP = 'sdd/sdd-agent-map.json';
const INT = 'sdd/spec-kit-integration.json';

// Scratch copy of standards/sdd (sdd/), the agent manifests (agents/) and the SDD fixtures (fx/).
function scenario(mutate = () => {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dac-sdd-'));
  cpSync(SDD, join(tmp, 'sdd'), { recursive: true });
  cpSync(AGENTS, join(tmp, 'agents'), { recursive: true });
  cpSync(FIX, join(tmp, 'fx'), { recursive: true });
  const edit = (file, fn) => { const p = join(tmp, file); const d = readJson(p); fn(d); writeFileSync(p, JSON.stringify(d, null, 2)); };
  try {
    mutate({ edit, tmp });
    return validatePaths([tmp], { root: tmp }).errors;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
const has = (errors, code, rule) => errors.some((e) => e.code === code && (rule === undefined || e.rule === rule));
const expectError = (name, file, fn, code, rule) => test(`negative: ${name}`, () => {
  const errors = scenario(({ edit }) => edit(file, fn));
  assert.ok(has(errors, code, rule), `expected ${code}${rule ? `[${rule}]` : ''}, got ${JSON.stringify(errors)}`);
});

// ---- positive ---------------------------------------------------------------
test('real SDD standards, agents and fixture projects validate cleanly', () => {
  assert.deepEqual(scenario(), []);
});

test('default validation covers standards/sdd and the CLI passes', () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'installer', 'validate.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS:/m);
});

test('each mode has a valid completed fixture and a planning-stage fixture needs no approval', () => {
  for (const f of [FULL, LIGHT, HOT, PLAN]) assert.deepEqual(scenario(({ edit }) => edit(f, () => {})), [], f);
  assert.equal(readJson(join(FIX, 'projects', 'project-full.json')).mode, 'full');
  assert.equal(readJson(join(FIX, 'projects', 'project-lightweight.json')).mode, 'lightweight');
  assert.equal(readJson(join(FIX, 'projects', 'project-hotfix.json')).mode, 'hotfix');
});

test('workflow has the ten canonical phases in order and three modes', () => {
  assert.deepEqual(workflow.phases.map((p) => p.id), ['constitution', 'specify', 'clarify', 'plan', 'checklist', 'tasks', 'analyze', 'implement', 'converge', 'independent-validation']);
  assert.deepEqual(PHASES, workflow.phases.map((p) => p.id));
  assert.deepEqual(workflow.modes.map((m) => m.id), ['full', 'lightweight', 'hotfix']);
  assert.deepEqual(mode('full').required_phases, PHASES);
  for (const id of ['full', 'lightweight', 'hotfix']) {
    const m = mode(id);
    assert.deepEqual([...m.required_phases, ...m.skippable_phases].sort(), [...PHASES].sort(), id);
    assert.ok(m.required_phases.includes('implement') && m.required_phases.includes('independent-validation'), id);
    assert.deepEqual(m.applies_gates, ['pre-implementation', 'pre-migration', 'pre-production-mutation', 'pre-deployment', 'pass'], id);
  }
  assert.deepEqual(mode('hotfix').excluded_change_types, ['migration', 'production-schema']);
});

test('all 8 primary agents plus the independent code-reviewer are mapped; reviewer never implements', () => {
  const primary = readJson(join(AGENTS, 'agent-catalog.json')).agents.filter((a) => a.classification === 'primary').map((a) => a.id);
  assert.equal(primary.length, 8);
  const mapped = new Map(agentMap.agents.map((a) => [a.agent, a]));
  for (const id of primary) assert.ok(mapped.has(id), id);
  const reviewer = mapped.get('code-reviewer');
  assert.equal(reviewer.role, 'independent-validator');
  assert.equal(reviewer.may_implement, false);
  assert.deepEqual(reviewer.phases, ['independent-validation']);
  assert.deepEqual(agentMap.agents.filter((a) => a.phases.includes('implement')).map((a) => a.agent).sort(), ['backend-expert', 'e2e-tester', 'frontend-expert', 'kmp-expert']);
  for (const p of PHASES) assert.ok(agentMap.agents.some((a) => a.phases.includes(p)), p);
});

test('agent manifests and instructions are untouched by SDD (no SDD or Spec Kit text)', () => {
  for (const n of readdirSync(AGENTS)) assert.doesNotMatch(readFileSync(join(AGENTS, n), 'utf8'), /\bsdd\b|spec[- ]?kit/i, n);
});

test('integration manifest is pinned to the verified release and not executable in this phase', () => {
  assert.equal(integration.status, 'not-installed');
  assert.equal(integration.test_status, 'untested');
  assert.equal(integration.execution_allowed_in_this_phase, false);
  assert.deepEqual(integration.upstream, {
    repository: 'https://github.com/github/spec-kit',
    release_tag: 'v1.4.0',
    published: '2026-11-10',
    tag_object: '14ddec8cb22db2a3b50e5ae6861b31053f132bfa',
    commit: '0019fa14d12f45edabc2cc3176c9168a68bd0f97',
    release_url: 'https://github.com/github/spec-kit/releases/tag/v1.4.0',
    license: 'MIT',
    license_url: 'https://github.com/github/spec-kit/blob/v1.4.0/LICENSE',
    copyright: 'Copyright GitHub, Inc.',
  });
  assert.equal(integration.install.source, 'git+https://github.com/github/spec-kit.git@v1.4.0');
  assert.equal(integration.install.method, 'adapter');
  assert.equal(integration.install.auto_install, false);
  assert.equal(integration.init.command_template, 'specify init <project> --integration <key>');
  assert.equal(integration.init.force.default, false);
  assert.equal(integration.init.force.requires_approval, true);
  assert.deepEqual(integration.workflow_order, PHASES);
  assert.equal(SPEC_KIT_PIN.commit, integration.upstream.commit);
});

test('SDD validation never executes anything or touches the network', () => {
  const src = readFileSync(join(REPO_ROOT, 'installer', 'lib', 'sdd.mjs'), 'utf8');
  assert.doesNotMatch(src, /child_process|node:net|node:http|node:https|fetch\(|writeFileSync|rmSync|mkdirSync|renameSync|copyFileSync|appendFileSync/);
});

// ---- milestone preservation ---------------------------------------------------
const MILESTONES = {
  'projects/milestones/milestone-01.md': '8279ce54c49ea8bd179f33530432c59dc053adaac03976ad758a22c82e45a099',
  'milestones/milestone-01.md': '0570368b65030671c1a5078da5787938a8acc1ed65c9531ddbe6231511cf2f0b',
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walkFiles = (d) => readdirSync(d).sort().flatMap((n) => { const p = join(d, n); return lstatSync(p).isDirectory() ? walkFiles(p) : [p]; });

test('milestone fixtures stay byte-identical (and unmodified in time) after validation', () => {
  const files = Object.keys(MILESTONES).map((rel) => join(FIX, rel));
  const before = files.map((f) => ({ sha: sha(f), mtime: statSync(f).mtimeMs, size: statSync(f).size }));
  const treeBefore = walkFiles(FIX).map((f) => `${f}:${sha(f)}`);
  const { errors } = validatePaths([SDD, AGENTS, FIX], { root: REPO_ROOT });
  assert.deepEqual(errors, []);
  const after = files.map((f) => ({ sha: sha(f), mtime: statSync(f).mtimeMs, size: statSync(f).size }));
  assert.deepEqual(after, before);
  assert.deepEqual(walkFiles(FIX).map((f) => `${f}:${sha(f)}`), treeBefore, 'no file added, removed or changed');
  for (const [rel, expected] of Object.entries(MILESTONES)) assert.equal(sha(join(FIX, rel)), expected, `${rel} differs from its pinned content`);
});

test('milestones are referenced additively: a project without milestone_ref is valid, with one it must exist', () => {
  assert.deepEqual(scenario(({ edit }) => edit(FULL, (d) => { delete d.milestone_ref; })), []);
  assert.equal(workflow.milestones.writes_allowed, false);
  assert.equal(workflow.milestones.compatibility, 'additive-read-only');
});
expectError('milestone_ref to a missing file', FULL, (d) => { d.milestone_ref = 'milestones/missing.md'; }, 'MISSING_REFERENCE', 'milestone-ref');
expectError('milestone_ref escaping upward', FULL, (d) => { d.milestone_ref = '../milestones/milestone-01.md'; }, 'PATH_TRAVERSAL');
expectError('milestone_ref absolute', FULL, (d) => { d.milestone_ref = '/etc/milestone.md'; }, 'ABSOLUTE_PATH');
expectError('milestone listed as a task path (write)', FULL, (d) => {
  d.scope.allowed_paths.push('milestones');
  d.tasks[0].paths.push('milestones');
}, 'SDD_SCOPE', 'milestone-write');
expectError('milestone listed as a changed file', FULL, (d) => {
  d.scope.allowed_paths.push('milestones');
  d.tasks[0].paths.push('milestones/milestone-01.md');
  d.files_changed.push('milestones/milestone-01.md');
}, 'SDD_SCOPE', 'milestone-write');
test('negative: project without workflow or agent map in the validated set', () => {
  const { errors } = validatePaths([join(FIX, 'projects')], { root: REPO_ROOT });
  assert.ok(has(errors, 'MISSING_REFERENCE', 'sdd-workflow'), JSON.stringify(errors));
  assert.ok(has(errors, 'MISSING_REFERENCE', 'sdd-agent-map'));
});

// ---- incomplete requirements and tasks ---------------------------------------
expectError('requirement without acceptance criteria', FULL, (d) => { d.requirements[0].acceptance_criteria = []; }, 'SDD_INCOMPLETE', 'artifact-field');
expectError('requirement with open questions after clarify', FULL, (d) => { d.requirements[0].open_questions = ['Which format?']; }, 'SDD_INCOMPLETE', 'open-questions');
expectError('implementation started with open questions (lightweight skips clarify)', LIGHT, (d) => { d.requirements[0].open_questions = ['Which label?']; }, 'SDD_INCOMPLETE', 'open-questions');
expectError('specified project with no requirements', FULL, (d) => { d.requirements = []; }, 'SDD_INCOMPLETE', 'no-requirements');
expectError('acceptance criterion without verification text', FULL, (d) => { d.acceptance_criteria[0].verification = '  '; }, 'SDD_INCOMPLETE', 'artifact-field');
expectError('task without acceptance criteria', FULL, (d) => { d.tasks[0].acceptance_criteria = []; }, 'SDD_INCOMPLETE', 'artifact-field');
expectError('task without requirements', FULL, (d) => { d.tasks[0].requirements = []; }, 'SDD_INCOMPLETE', 'artifact-field');
expectError('decision without rationale', FULL, (d) => { d.decisions[0].rationale = ' '; }, 'SDD_INCOMPLETE', 'artifact-field');
expectError('risk without mitigation', FULL, (d) => { d.risks[0].mitigation = ''; }, 'SCHEMA_CONSTRAINT');
expectError('planned project with no tasks', PLAN, (d) => { d.tasks = []; d.risks = []; }, 'SDD_INCOMPLETE', 'no-tasks');
expectError('requirement not covered by any task', FULL, (d) => {
  d.requirements.push({ id: 'req-3', statement: 'An uncovered requirement.', acceptance_criteria: ['ac-4'], open_questions: [] });
  d.acceptance_criteria.push({ id: 'ac-4', requirement: 'req-3', statement: 'Never verified.', verification: 'None planned.' });
}, 'SDD_TRACE', 'requirement-without-task');
expectError('requirement without a technical decision (full mode)', FULL, (d) => { d.decisions[0].requirements = ['req-1']; }, 'SDD_TRACE', 'requirement-without-decision');
expectError('high risk without a task (full mode)', FULL, (d) => { d.risks[0].tasks = []; }, 'SDD_TRACE', 'risk-without-task');
expectError('artifact contract field removed from the workflow does not hide gaps: missing artifact contract', WF, (d) => { d.artifact_contracts.pop(); }, 'SDD_INCOMPLETE', 'artifact-contracts');
expectError('phase removed from the workflow', WF, (d) => { d.phases.splice(2, 1); }, 'SDD_INCOMPLETE', 'phase-order');
expectError('phases out of order', WF, (d) => { d.phases.reverse(); }, 'SDD_INCOMPLETE', 'phase-order');

// ---- broken references and traceability ---------------------------------------
expectError('task references an unknown requirement', FULL, (d) => { d.tasks[0].requirements.push('req-9'); }, 'SDD_TRACE', 'broken-ref');
expectError('task references an unknown criterion', FULL, (d) => { d.tasks[0].acceptance_criteria.push('ac-9'); }, 'SDD_TRACE', 'broken-ref');
expectError('requirement references an unknown criterion', FULL, (d) => { d.requirements[0].acceptance_criteria.push('ac-9'); }, 'SDD_TRACE', 'broken-ref');
expectError('criterion references an unknown requirement', FULL, (d) => { d.acceptance_criteria[0].requirement = 'req-9'; }, 'SDD_TRACE', 'broken-ref');
expectError('decision references an unknown requirement', FULL, (d) => { d.decisions[0].requirements.push('req-9'); }, 'SDD_TRACE', 'broken-ref');
expectError('risk references an unknown task', FULL, (d) => { d.risks[0].tasks.push('task-9'); }, 'SDD_TRACE', 'broken-ref');
expectError('evidence references an unknown criterion', FULL, (d) => { d.validation.evidence[0].criteria.push('ac-9'); }, 'SDD_TRACE', 'broken-ref');
expectError('criterion not linked back from its requirement', FULL, (d) => { d.requirements[0].acceptance_criteria = ['ac-1']; }, 'SDD_TRACE', 'requirement-backlink');
expectError('requirement lists a criterion owned by another requirement', FULL, (d) => { d.requirements[1].acceptance_criteria.push('ac-2'); }, 'SDD_TRACE', 'criterion-backlink');
expectError('task cites a criterion of a requirement it does not reference', FULL, (d) => { d.tasks[1].acceptance_criteria.push('ac-1'); }, 'SDD_TRACE', 'criterion-requirement-mismatch');
expectError('duplicate task ids', FULL, (d) => { d.tasks[1].id = 'task-1'; }, 'SDD_TRACE', 'duplicate-id');
expectError('criterion without evidence at PASS', FULL, (d) => { d.validation.evidence[1].criteria = []; }, 'SDD_TRACE', 'uncovered-criterion');
expectError('workflow_order differs from the canonical workflow', INT, (d) => { d.workflow_order = d.workflow_order.slice(1); }, 'SDD_TRACE', 'workflow-order');

// ---- approval gates -----------------------------------------------------------
expectError('implementation without approval', FULL, (d) => { d.approvals = []; }, 'SDD_GATE', 'implementation-without-approval');
expectError('implementation with a denied approval', FULL, (d) => { d.approvals[0].granted = false; }, 'SDD_GATE', 'implementation-without-approval');
expectError('approval for a different gate does not count', FULL, (d) => { d.approvals[0].gate = 'pass'; }, 'SDD_GATE', 'implementation-without-approval');
expectError('agent-granted approval is not allowed', FULL, (d) => { d.approvals[0].approver_type = 'agent'; }, 'SCHEMA_INVALID_VALUE');
expectError('approval for an unknown gate', FULL, (d) => { d.approvals.push({ gate: 'pre-lunch', granted: true, approver_type: 'human', approver: 'x', reference: 'y' }); }, 'SDD_GATE', 'unknown-gate');
expectError('hotfix cannot bypass approval', HOT, (d) => { d.approvals = []; }, 'SDD_GATE', 'implementation-without-approval');
expectError('files changed while every task is planned and nothing approved', PLAN, (d) => { d.files_changed = ['migrations/001.txt']; }, 'SDD_GATE', 'implementation-without-approval');
expectError('implement completed before a required phase', FULL, (d) => { d.completed_phases = d.completed_phases.filter((p) => p !== 'plan'); }, 'SDD_GATE', 'prerequisite-phases');
expectError('phase completed out of order', FULL, (d) => { d.completed_phases = d.completed_phases.filter((p) => p !== 'tasks'); }, 'SDD_MODE', 'phase-order');
expectError('migration started without migration approval', PLAN, (d) => {
  d.tasks[0].status = 'in-progress';
  d.completed_phases.push('implement');
  d.approvals = [{ gate: 'pre-implementation', granted: true, approver_type: 'human', approver: 'project-owner', reference: 'approval record 4' }];
}, 'SDD_GATE', 'missing-approval');
expectError('migration started without any approval', PLAN, (d) => { d.tasks[0].status = 'in-progress'; }, 'SDD_GATE', 'implementation-without-approval');
expectError('migration started without a rollback plan', PLAN, (d) => {
  d.tasks[0].status = 'in-progress';
  d.completed_phases.push('implement');
  d.risks = [];
  d.approvals = ['pre-implementation', 'pre-migration'].map((gate) => ({ gate, granted: true, approver_type: 'human', approver: 'project-owner', reference: 'approval record 5' }));
}, 'SDD_GATE', 'rollback-plan');
test('positive: migration started with implementation + migration approvals and a rollback plan', () => {
  const errors = scenario(({ edit }) => edit(PLAN, (d) => {
    d.tasks[0].status = 'in-progress';
    d.approvals = ['pre-implementation', 'pre-migration'].map((gate) => ({ gate, granted: true, approver_type: 'human', approver: 'project-owner', reference: 'approval record 5' }));
    d.completed_phases.push('implement');
    d.files_changed = ['migrations/001.txt'];
  }));
  assert.deepEqual(errors, []);
});
expectError('production mutation started without approval', FULL, (d) => {
  d.tasks.push({ id: 'task-4', title: 'Patch production data', owner: 'backend-expert', change_type: 'production-mutation', status: 'in-progress', requirements: ['req-1'], acceptance_criteria: ['ac-1'], paths: ['src/api'] });
  d.risks[0].tasks.push('task-4');
}, 'SDD_GATE', 'missing-approval');
expectError('production schema change started without approval', FULL, (d) => {
  d.tasks.push({ id: 'task-4', title: 'Alter production schema', owner: 'backend-expert', change_type: 'production-schema', status: 'in-progress', requirements: ['req-1'], acceptance_criteria: ['ac-1'], paths: ['src/api'] });
}, 'SDD_GATE', 'missing-approval');
expectError('deployment started without approval', FULL, (d) => {
  d.tasks.push({ id: 'task-4', title: 'Deploy', owner: 'backend-expert', change_type: 'deployment', status: 'in-progress', requirements: ['req-1'], acceptance_criteria: ['ac-1'], paths: ['src/api'] });
}, 'SDD_GATE', 'missing-approval');
expectError('deployment before independent PASS', FULL, (d) => {
  d.tasks.push({ id: 'task-4', title: 'Deploy', owner: 'backend-expert', change_type: 'deployment', status: 'in-progress', requirements: ['req-1'], acceptance_criteria: ['ac-1'], paths: ['src/api'] });
  d.approvals.push({ gate: 'pre-deployment', granted: true, approver_type: 'human', approver: 'project-owner', reference: 'approval record 6' });
  d.validation = { validation_result: 'NOT-RUN', validated_by: '', evidence: [] };
  d.completed_phases = d.completed_phases.filter((p) => p !== 'independent-validation');
}, 'SDD_GATE', 'deploy-before-validation');

// ---- PASS gate: evidence and independence --------------------------------------
expectError('PASS without evidence', FULL, (d) => { d.validation.evidence = []; }, 'SDD_GATE', 'pass-without-evidence');
expectError('PASS with placeholder evidence', FULL, (d) => { d.validation.evidence.forEach((e) => { e.description = 'ok'; }); }, 'SDD_GATE', 'pass-without-evidence');
expectError('PASS with placeholder evidence leaves criteria uncovered', FULL, (d) => { d.validation.evidence.forEach((e) => { e.description = 'n/a'; }); }, 'SDD_TRACE', 'uncovered-criterion');
expectError('PASS validated only by an implementer', FULL, (d) => { d.validation.validated_by = 'backend-expert'; }, 'SDD_GATE', 'implementer-validation');
expectError('PASS validated by an implementer that owns no task', FULL, (d) => { d.validation.validated_by = 'kmp-expert'; }, 'SDD_GATE', 'implementer-validation');
expectError('PASS validated by an advisor', FULL, (d) => { d.validation.validated_by = 'repo-analyst'; }, 'SDD_GATE', 'independent-validation');
expectError('PASS validated by an unknown party', FULL, (d) => { d.validation.validated_by = 'ghost-agent'; }, 'SDD_GATE', 'independent-validation');
expectError('PASS without a validator', FULL, (d) => { d.validation.validated_by = ''; }, 'SDD_GATE', 'independent-validation');
expectError('malformed non-empty validator id is rejected by the schema', FULL, (d) => { d.validation.validated_by = 'Not A Valid ID!'; }, 'SCHEMA_CONSTRAINT');
expectError('PASS with unfinished tasks', FULL, (d) => { d.tasks[0].status = 'in-progress'; }, 'SDD_GATE', 'tasks-not-done');
expectError('PASS with a required phase not completed', FULL, (d) => { d.completed_phases = d.completed_phases.filter((p) => p !== 'converge'); }, 'SDD_GATE', 'prerequisite-phases');
expectError('independent-validation completed without PASS', FULL, (d) => { d.validation.validation_result = 'FAIL'; }, 'SDD_GATE', 'validation-state');
expectError('PASS with no acceptance criteria at all', LIGHT, (d) => {
  d.acceptance_criteria = []; d.requirements[0].acceptance_criteria = []; d.tasks[0].acceptance_criteria = []; d.validation.evidence[0].criteria = [];
}, 'SDD_INCOMPLETE', 'no-criteria');

// ---- scope ----------------------------------------------------------------------
expectError('changed file outside the allowed scope', FULL, (d) => { d.files_changed.push('docs/readme.txt'); }, 'SDD_SCOPE', 'out-of-scope');
expectError('changed file inside a prohibited path', FULL, (d) => { d.files_changed.push('src/secrets/key.txt'); d.tasks[0].paths.push('src/secrets'); }, 'SDD_SCOPE', 'out-of-scope');
expectError('task path outside the allowed scope', FULL, (d) => { d.tasks[0].paths.push('infra'); }, 'SDD_SCOPE', 'out-of-scope');
expectError('changed file in scope but not planned by any task', FULL, (d) => { d.files_changed.push('src/other/file.txt'); }, 'SDD_SCOPE', 'unplanned-change');
expectError('sibling directory with a shared prefix is not in scope', FULL, (d) => { d.files_changed.push('srcother/file.txt'); }, 'SDD_SCOPE', 'out-of-scope');
expectError('task path with traversal', FULL, (d) => { d.tasks[0].paths.push('src/../infra'); }, 'PATH_TRAVERSAL');
expectError('task path absolute', FULL, (d) => { d.tasks[0].paths.push('/var/data'); }, 'ABSOLUTE_PATH');
expectError('changed file with traversal', FULL, (d) => { d.files_changed.push('src/../infra/x'); }, 'PATH_TRAVERSAL');
expectError('scope granted for the whole repository', FULL, (d) => { d.scope.allowed_paths = ['.']; }, 'DANGEROUS_PERMISSION', 'broad-path-grant');

// ---- owners and agent map ---------------------------------------------------------
expectError('task with an unknown owner', FULL, (d) => { d.tasks[0].owner = 'ghost-agent'; }, 'SDD_TRACE', 'unknown-owner');
expectError('task owned by the independent reviewer', FULL, (d) => { d.tasks[0].owner = 'code-reviewer'; }, 'SDD_GATE', 'owner-not-implementer');
expectError('task owned by an advisor', FULL, (d) => { d.tasks[0].owner = 'technical-planner'; }, 'SDD_GATE', 'owner-not-implementer');
expectError('agent map entry for an unknown agent', MAP, (d) => { d.agents.push({ agent: 'ghost-agent', role: 'analyst', phases: ['constitution'], may_implement: false, rationale: 'Not a real agent.' }); }, 'MISSING_REFERENCE', 'sdd-agent');
expectError('primary agent missing from the map', MAP, (d) => { d.agents = d.agents.filter((a) => a.agent !== 'kmp-expert'); }, 'SDD_INCOMPLETE', 'primary-unmapped');
expectError('agent mapped twice', MAP, (d) => { d.agents.push({ ...d.agents[0] }); }, 'SDD_TRACE', 'duplicate-agent');
expectError('code-reviewer turned into an implementer', MAP, (d) => {
  const r = d.agents.find((a) => a.agent === 'code-reviewer'); r.role = 'implementer'; r.may_implement = true; r.phases = ['implement'];
}, 'SDD_GATE', 'reviewer-independence');
expectError('code-reviewer mapped to implement', MAP, (d) => { d.agents.find((a) => a.agent === 'code-reviewer').phases.push('implement'); }, 'SDD_GATE', 'implement-phase-owner');
expectError('implementer mapped as independent validator', MAP, (d) => {
  const a = d.agents.find((x) => x.agent === 'backend-expert'); a.role = 'independent-validator'; a.may_implement = false; a.phases = ['independent-validation'];
}, 'SDD_GATE', 'role-function');
expectError('advisor mapped to implement', MAP, (d) => { d.agents.find((a) => a.agent === 'repo-analyst').phases.push('implement'); }, 'SDD_GATE', 'implement-phase-owner');
expectError('implementer flag inconsistent with role', MAP, (d) => { d.agents.find((a) => a.agent === 'backend-expert').may_implement = false; }, 'SDD_GATE', 'implementer-flag');
expectError('phase with no agent', MAP, (d) => { d.agents = d.agents.filter((a) => a.agent !== 'repo-analyst'); d.agents.find((a) => a.agent === 'technical-planner').phases = ['specify', 'plan', 'checklist', 'tasks', 'analyze']; }, 'SDD_INCOMPLETE', 'phase-uncovered');
expectError('agent map references an unknown phase', MAP, (d) => { d.agents[0].phases.push('ship-it'); }, 'SDD_TRACE', 'unknown-phase');

// ---- modes and gates ------------------------------------------------------------------
expectError('project with an unknown mode', FULL, (d) => { d.mode = 'turbo'; }, 'SDD_MODE', 'unknown-mode');
expectError('required phase skipped', LIGHT, (d) => { d.skipped_phases.push({ phase: 'plan', reason: 'in a hurry' }); d.completed_phases = d.completed_phases.filter((p) => p !== 'plan'); }, 'SDD_MODE', 'required-phase-skipped');
expectError('phase skipped in full mode', FULL, (d) => { d.skipped_phases.push({ phase: 'analyze', reason: 'in a hurry' }); d.completed_phases = d.completed_phases.filter((p) => p !== 'analyze'); }, 'SDD_MODE', 'required-phase-skipped');
expectError('phase both completed and skipped', LIGHT, (d) => { d.skipped_phases.push({ phase: 'plan', reason: 'x' }); }, 'SDD_MODE', 'phase-both');
expectError('unknown phase completed', FULL, (d) => { d.completed_phases.push('ship-it'); }, 'SDD_MODE', 'unknown-phase');
expectError('hotfix covering a migration', HOT, (d) => { d.tasks[0].change_type = 'migration'; }, 'SDD_MODE', 'excluded-change-type');
expectError('hotfix covering a production schema change', HOT, (d) => { d.tasks[0].change_type = 'production-schema'; }, 'SDD_MODE', 'excluded-change-type');
expectError('hotfix larger than its task budget', HOT, (d) => {
  for (const n of [2, 3, 4]) d.tasks.push({ ...d.tasks[0], id: `task-${n}` });
}, 'SDD_MODE', 'max-tasks');
expectError('lightweight larger than its task budget', LIGHT, (d) => {
  for (let n = 2; n <= 11; n++) d.tasks.push({ ...d.tasks[0], id: `task-${n}` });
}, 'SDD_MODE', 'max-tasks');
expectError('workflow: hotfix may skip independent validation', WF, (d) => {
  const h = d.modes.find((m) => m.id === 'hotfix'); h.required_phases = h.required_phases.filter((p) => p !== 'independent-validation'); h.skippable_phases.push('independent-validation');
}, 'SDD_MODE', 'phase-required');
expectError('workflow: hotfix may skip implement', WF, (d) => {
  const h = d.modes.find((m) => m.id === 'hotfix'); h.required_phases = h.required_phases.filter((p) => p !== 'implement'); h.skippable_phases.push('implement');
}, 'SDD_MODE', 'phase-required');
expectError('workflow: hotfix bypasses the PASS gate', WF, (d) => { const h = d.modes.find((m) => m.id === 'hotfix'); h.applies_gates = h.applies_gates.filter((g) => g !== 'pass'); }, 'SDD_GATE', 'gate-bypass');
expectError('workflow: hotfix bypasses the implementation gate', WF, (d) => { const h = d.modes.find((m) => m.id === 'hotfix'); h.applies_gates = h.applies_gates.filter((g) => g !== 'pre-implementation'); }, 'SDD_GATE', 'gate-bypass');
expectError('workflow: lightweight bypasses the migration gate', WF, (d) => { const l = d.modes.find((m) => m.id === 'lightweight'); l.applies_gates = l.applies_gates.filter((g) => g !== 'pre-migration'); }, 'SDD_GATE', 'gate-bypass');
expectError('workflow: hotfix no longer excludes migrations', WF, (d) => { d.modes.find((m) => m.id === 'hotfix').excluded_change_types = ['production-schema']; }, 'SDD_MODE', 'hotfix-scope');
expectError('workflow: hotfix no longer excludes production schema', WF, (d) => { d.modes.find((m) => m.id === 'hotfix').excluded_change_types = ['migration']; }, 'SDD_MODE', 'hotfix-scope');
expectError('workflow: hotfix without a task budget', WF, (d) => { delete d.modes.find((m) => m.id === 'hotfix').max_tasks; }, 'SDD_MODE', 'hotfix-size');
expectError('workflow: full mode skips a phase', WF, (d) => {
  const f = d.modes.find((m) => m.id === 'full'); f.required_phases = f.required_phases.filter((p) => p !== 'analyze'); f.skippable_phases.push('analyze');
}, 'SDD_MODE', 'full-skips');
expectError('workflow: phase both required and skippable', WF, (d) => { d.modes.find((m) => m.id === 'lightweight').skippable_phases.push('plan'); }, 'SDD_MODE', 'phase-overlap');
expectError('workflow: phase neither required nor skippable', WF, (d) => { const l = d.modes.find((m) => m.id === 'lightweight'); l.skippable_phases = l.skippable_phases.filter((p) => p !== 'analyze'); }, 'SDD_MODE', 'phase-unclassified');
expectError('workflow: invalid mode id', WF, (d) => { d.modes[1].id = 'turbo'; }, 'SDD_MODE', 'unknown-mode');
expectError('workflow: missing mode', WF, (d) => { d.modes = d.modes.filter((m) => m.id !== 'lightweight'); }, 'SDD_MODE', 'missing-mode');
expectError('workflow: mode references an unknown phase', WF, (d) => { d.modes[0].skippable_phases.push('ship-it'); }, 'SDD_MODE', 'unknown-phase');
expectError('workflow: mode drops a core traceability link', WF, (d) => { d.modes[2].traceability = d.modes[2].traceability.filter((l) => l !== 'criterion-to-evidence'); }, 'SDD_TRACE', 'missing-link');
expectError('workflow: unknown traceability link', WF, (d) => { d.modes[0].traceability.push('vibes-to-code'); }, 'SDD_TRACE', 'unknown-link');
expectError('workflow: required gate missing', WF, (d) => { d.gates = d.gates.filter((g) => g.id !== 'pre-deployment'); }, 'SDD_GATE', 'missing-gate');
expectError('workflow: unknown gate', WF, (d) => { d.gates.push({ id: 'pre-lunch', blocks: 'Lunch.', requires_human_approval: false, requires: [] }); }, 'SDD_GATE', 'unknown-gate');
expectError('workflow: duplicate gate', WF, (d) => { d.gates.push({ ...d.gates[0] }); }, 'SDD_GATE', 'duplicate-gate');
expectError('workflow: blocking gate without human approval', WF, (d) => { d.gates[0].requires_human_approval = false; }, 'SDD_GATE', 'approval-required');
expectError('workflow: migration gate without human approval', WF, (d) => { d.gates.find((g) => g.id === 'pre-migration').requires_human_approval = false; }, 'SDD_GATE', 'approval-required');
expectError('workflow: PASS gate without independent validation', WF, (d) => { const g = d.gates.find((x) => x.id === 'pass'); g.requires = g.requires.filter((c) => c !== 'independent-validation'); }, 'SDD_GATE', 'missing-condition');
expectError('workflow: PASS gate without useful evidence', WF, (d) => { const g = d.gates.find((x) => x.id === 'pass'); g.requires = g.requires.filter((c) => c !== 'useful-evidence'); }, 'SDD_GATE', 'missing-condition');
expectError('workflow: unknown gate condition', WF, (d) => { d.gates[0].requires.push('vibes-check'); }, 'SDD_GATE', 'unknown-condition');
expectError('workflow: milestones may be written', WF, (d) => { d.milestones.writes_allowed = true; }, 'SCHEMA_INVALID_VALUE');
expectError('workflow: milestone compatibility not additive', WF, (d) => { d.milestones.compatibility = 'replace'; }, 'SCHEMA_INVALID_VALUE');
expectError('workflow: unknown field', WF, (d) => { d.extra = true; }, 'SCHEMA_UNKNOWN_FIELD');
expectError('workflow: artifact produced by a phase that does not declare it', WF, (d) => { d.artifact_contracts[0].produced_in = 'plan'; }, 'SDD_TRACE', 'artifact-producer');
test('negative: two workflows in one validated set', () => {
  const errors = scenario(({ tmp }) => cpSync(join(tmp, 'sdd', 'sdd-workflow.json'), join(tmp, 'sdd', 'second-workflow.json')));
  assert.ok(has(errors, 'DUPLICATE_ID'), JSON.stringify(errors));
});

// ---- integration safety -----------------------------------------------------------------
expectError('wrong release tag', INT, (d) => { d.upstream.release_tag = 'v1.5.0'; }, 'SDD_PIN', 'pin-mismatch');
expectError('wrong peeled commit', INT, (d) => { d.upstream.commit = '0'.repeat(40); }, 'SDD_PIN', 'pin-mismatch');
expectError('wrong tag object', INT, (d) => { d.upstream.tag_object = '1'.repeat(40); }, 'SDD_PIN', 'pin-mismatch');
expectError('wrong license', INT, (d) => { d.upstream.license = 'Apache-2.0'; }, 'SDD_PIN', 'pin-mismatch');
expectError('wrong repository', INT, (d) => { d.upstream.repository = 'https://github.com/example/spec-kit'; }, 'SDD_PIN', 'pin-mismatch');
expectError('install source on a branch', INT, (d) => { d.install.source = 'git+https://github.com/github/spec-kit.git@main'; }, 'SDD_PIN', 'source-pin');
expectError('install source unpinned', INT, (d) => { d.install.source = 'git+https://github.com/github/spec-kit.git'; }, 'SDD_PIN', 'source-pin');
expectError('install source on the commit of another tag', INT, (d) => { d.install.source = 'git+https://github.com/github/spec-kit.git@latest'; }, 'SDD_PIN', 'source-pin');
expectError('install flagged unpinned', INT, (d) => { d.install.pinned = false; }, 'SDD_PIN', 'unpinned');
expectError('execution allowed in this phase', INT, (d) => { d.execution_allowed_in_this_phase = true; }, 'SDD_INTEGRATION', 'execution-allowed');
expectError('status installed', INT, (d) => { d.status = 'installed'; }, 'SDD_INTEGRATION', 'status');
expectError('status tested', INT, (d) => { d.test_status = 'tested'; }, 'SDD_INTEGRATION', 'test-status');
expectError('automatic install', INT, (d) => { d.install.auto_install = true; }, 'SDD_INTEGRATION', 'auto-install');
expectError('install without approval', INT, (d) => { d.install.requires_approval = false; }, 'SDD_INTEGRATION', 'install-approval');
expectError('install method not adapter-based', INT, (d) => { d.install.method = 'curl-pipe'; }, 'SCHEMA_INVALID_VALUE');
expectError('init without explicit integration key', INT, (d) => { d.init.integration_flag_required = false; }, 'SDD_INTEGRATION', 'integration-flag');
expectError('init template without --integration', INT, (d) => { d.init.command_template = 'specify init <project>'; }, 'SDD_INTEGRATION', 'init-template');
expectError('init template embeds --force', INT, (d) => { d.init.command_template = 'specify init <project> --integration <key> --force'; }, 'SDD_INTEGRATION', 'init-template');
expectError('non-interactive flag changed', INT, (d) => { d.init.non_interactive_flag = '--yes'; }, 'SDD_INTEGRATION', 'non-interactive');
expectError('--force on by default', INT, (d) => { d.init.force.default = true; }, 'SDD_INTEGRATION', 'force');
expectError('--force without approval', INT, (d) => { d.init.force.requires_approval = false; }, 'SDD_INTEGRATION', 'force');
expectError('existing-project precondition dropped (backup)', INT, (d) => { d.init.existing_project_preconditions = d.init.existing_project_preconditions.filter((p) => p !== 'backup-created'); }, 'SDD_INTEGRATION', 'precondition');
expectError('existing-project precondition dropped (conflict report)', INT, (d) => { d.init.existing_project_preconditions = d.init.existing_project_preconditions.filter((p) => p !== 'conflict-report-reviewed'); }, 'SDD_INTEGRATION', 'precondition');
expectError('managed path escaping the project', INT, (d) => { d.managed_paths.paths.push('../outside'); }, 'PATH_TRAVERSAL');
expectError('managed path absolute', INT, (d) => { d.managed_paths.paths.push('/usr/local'); }, 'ABSOLUTE_PATH');
expectError('managed path is the whole project', INT, (d) => { d.managed_paths.paths.push('.'); }, 'SDD_INTEGRATION', 'managed-path');
expectError('managed path covers version control', INT, (d) => { d.managed_paths.paths.push('.git/hooks'); }, 'SDD_INTEGRATION', 'managed-path');
expectError('managed path covers CI configuration', INT, (d) => { d.managed_paths.paths.push('.github'); }, 'SDD_INTEGRATION', 'managed-path');
expectError('managed paths claimed verified before install', INT, (d) => { d.managed_paths.verification = 'verified'; }, 'SDD_INTEGRATION', 'managed-path-verification');
expectError('conflict detection disabled', INT, (d) => { d.conflict_detection.enabled = false; }, 'SDD_INTEGRATION', 'conflict-detection');
expectError('conflict report not required', INT, (d) => { d.conflict_detection.report_required_before_write = false; }, 'SDD_INTEGRATION', 'conflict-detection');
expectError('conflict strategy overwrite', INT, (d) => { d.conflict_detection.strategy = 'overwrite'; }, 'SCHEMA_INVALID_VALUE');
expectError('backup not required', INT, (d) => { d.backup.required = false; }, 'SDD_INTEGRATION', 'backup');
expectError('backup after writes', INT, (d) => { d.backup.before_any_write = false; }, 'SDD_INTEGRATION', 'backup');
expectError('rollback not verified', INT, (d) => { d.rollback.verify_after = false; }, 'SDD_INTEGRATION', 'rollback');
expectError('rollback strategy changed', INT, (d) => { d.rollback.strategy = 'best-effort'; }, 'SCHEMA_INVALID_VALUE');
expectError('integration missing required field', INT, (d) => { delete d.backup; }, 'SCHEMA_MISSING_FIELD');
expectError('integration with an extra executable field', INT, (d) => { d.post_install = 'run it'; }, 'SCHEMA_UNKNOWN_FIELD');
expectError('integration carrying a credential', INT, (d) => { d.description = 'token=' + 'Zx81QpLm20Vb77TrQ'; }, 'SECRET_PATTERN');
expectError('integration with a machine path', INT, (d) => { d.managed_paths.note = 'See ' + '/home' + '/someone/notes'; }, 'ABSOLUTE_PATH');
