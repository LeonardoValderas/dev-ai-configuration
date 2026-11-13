// SDD (Spec-Driven Development) policy checks. Read-only: pure functions over
// parsed JSON, plus lstat-only milestone existence checks (never reads or writes
// milestone content). Complements schema validation and checks.mjs.
import { lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hasUsefulEvidence } from './checks.mjs';
import { confine } from './confine.mjs';

// Pinned, verified upstream facts for the declarative Spec Kit integration.
export const SPEC_KIT_PIN = Object.freeze({
  repository: 'https://github.com/github/spec-kit',
  release_tag: 'v1.4.0',
  published: '2026-11-10',
  tag_object: '14ddec8cb22db2a3b50e5ae6861b31053f132bfa',
  commit: '0019fa14d12f45edabc2cc3176c9168a68bd0f97',
  release_url: 'https://github.com/github/spec-kit/releases/tag/v1.4.0',
  license: 'MIT',
  license_url: 'https://github.com/github/spec-kit/blob/v1.4.0/LICENSE',
  copyright: 'Copyright GitHub, Inc.',
  source: 'git+https://github.com/github/spec-kit.git@v1.4.0',
});

export const PHASES = ['constitution', 'specify', 'clarify', 'plan', 'checklist', 'tasks', 'analyze', 'implement', 'converge', 'independent-validation'];
export const MODES = ['full', 'lightweight', 'hotfix'];
export const GATES = ['pre-implementation', 'pre-migration', 'pre-production-mutation', 'pre-deployment', 'pass'];
const BLOCKING_APPROVAL = ['pre-implementation', 'pre-migration', 'pre-production-mutation', 'pre-deployment'];
export const ARTIFACTS = ['requirements', 'acceptance-criteria', 'technical-decisions', 'tasks', 'risks', 'validation-evidence', 'traceability'];
const LINKS = ['requirement-to-criterion', 'task-to-requirement', 'task-to-criterion', 'criterion-to-evidence', 'decision-to-requirement', 'risk-to-task'];
const CORE_LINKS = LINKS.slice(0, 4);
const CONDITIONS = new Set(['requirements-complete', 'tasks-have-criteria', 'traceability-complete', 'required-phases-complete', 'scope-confined', 'pre-implementation-passed', 'rollback-plan-recorded', 'independent-validation', 'useful-evidence', 'all-criteria-covered', 'tasks-done']);
const ALWAYS_REQUIRED = ['specify', 'tasks', 'implement', 'independent-validation'];
const HOTFIX_EXCLUDED = ['migration', 'production-schema'];
const PRECONDITIONS = ['inspect-project', 'backup-created', 'conflict-report-reviewed', 'explicit-approval'];
// change type -> gates that must be approved before the work may start
const CHANGE_GATES = {
  migration: ['pre-migration'],
  'production-schema': ['pre-migration', 'pre-production-mutation'],
  'production-mutation': ['pre-production-mutation'],
  deployment: ['pre-deployment'],
};
const ROLLBACK_TYPES = new Set(['migration', 'production-schema', 'production-mutation']);
// artifact contract id -> where the items live in an sdd-project
const COLLECTIONS = {
  requirements: (d) => d.requirements,
  'acceptance-criteria': (d) => d.acceptance_criteria,
  'technical-decisions': (d) => d.decisions,
  tasks: (d) => d.tasks,
  risks: (d) => d.risks,
  'validation-evidence': (d) => d.validation?.evidence,
};

const err = (code, rule, path, message) => ({ code, rule, path, message });
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const dupes = (list) => list.filter((x, i) => list.indexOf(x) !== i);
const isSafeRel = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !/^[A-Za-z]:|^[~\\]/.test(p) && !p.split(/[\\/]/).includes('..');
const norm = (p) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
const within = (file, dir) => { const f = norm(file); const d = norm(dir); return f === d || f.startsWith(`${d}/`); };
const BROAD = /^(\.|\/|\*+|\*\*\/\*|\.\/\*\*?)?$/;

// ---- workflow ---------------------------------------------------------------
export function checkWorkflow(doc) {
  const errors = [];
  const phaseIds = doc.phases.map((p) => p.id);
  if (!same(phaseIds, PHASES)) errors.push(err('SDD_INCOMPLETE', 'phase-order', '$.phases', `phases must be exactly, in order: ${PHASES.join(', ')}`));
  const artifactIds = doc.artifact_contracts.map((a) => a.id);
  if (!same([...artifactIds].sort(), [...ARTIFACTS].sort())) errors.push(err('SDD_INCOMPLETE', 'artifact-contracts', '$.artifact_contracts', `artifact contracts must be exactly: ${ARTIFACTS.join(', ')}`));
  doc.phases.forEach((p, i) => p.produces.forEach((a) => {
    if (!ARTIFACTS.includes(a)) errors.push(err('SDD_TRACE', 'unknown-artifact', `$.phases[${i}].produces`, `unknown artifact "${a}"`));
  }));
  doc.artifact_contracts.forEach((a, i) => {
    if (!PHASES.includes(a.produced_in)) errors.push(err('SDD_TRACE', 'unknown-phase', `$.artifact_contracts[${i}].produced_in`, `unknown phase "${a.produced_in}"`));
    else if (!doc.phases.find((p) => p.id === a.produced_in)?.produces.includes(a.id)) errors.push(err('SDD_TRACE', 'artifact-producer', `$.artifact_contracts[${i}].produced_in`, `phase "${a.produced_in}" does not declare producing "${a.id}"`));
  });

  const gateIds = doc.gates.map((g) => g.id);
  for (const d of dupes(gateIds)) errors.push(err('SDD_GATE', 'duplicate-gate', '$.gates', `duplicate gate "${d}"`));
  for (const g of GATES) if (!gateIds.includes(g)) errors.push(err('SDD_GATE', 'missing-gate', '$.gates', `required gate "${g}" is not defined`));
  doc.gates.forEach((g, i) => {
    if (!GATES.includes(g.id)) errors.push(err('SDD_GATE', 'unknown-gate', `$.gates[${i}].id`, `unknown gate "${g.id}"`));
    if (BLOCKING_APPROVAL.includes(g.id) && g.requires_human_approval !== true) errors.push(err('SDD_GATE', 'approval-required', `$.gates[${i}].requires_human_approval`, `gate "${g.id}" must require human approval`));
    for (const c of g.requires) if (!CONDITIONS.has(c)) errors.push(err('SDD_GATE', 'unknown-condition', `$.gates[${i}].requires`, `unknown gate condition "${c}"`));
    const need = g.id === 'pass' ? ['independent-validation', 'useful-evidence', 'all-criteria-covered'] : g.id === 'pre-implementation' ? ['requirements-complete', 'tasks-have-criteria', 'traceability-complete', 'scope-confined'] : [];
    for (const c of need) if (!g.requires.includes(c)) errors.push(err('SDD_GATE', 'missing-condition', `$.gates[${i}].requires`, `gate "${g.id}" must require "${c}"`));
  });

  const modeIds = doc.modes.map((m) => m.id);
  for (const d of dupes(modeIds)) errors.push(err('SDD_MODE', 'duplicate-mode', '$.modes', `duplicate mode "${d}"`));
  for (const m of MODES) if (!modeIds.includes(m)) errors.push(err('SDD_MODE', 'missing-mode', '$.modes', `required mode "${m}" is not defined`));
  doc.modes.forEach((m, i) => {
    const at = (f) => `$.modes[${i}].${f}`;
    if (!MODES.includes(m.id)) { errors.push(err('SDD_MODE', 'unknown-mode', at('id'), `unknown mode "${m.id}"`)); return; }
    for (const f of ['required_phases', 'skippable_phases']) for (const p of m[f]) if (!PHASES.includes(p)) errors.push(err('SDD_MODE', 'unknown-phase', at(f), `unknown phase "${p}"`));
    const overlap = m.required_phases.filter((p) => m.skippable_phases.includes(p));
    if (overlap.length) errors.push(err('SDD_MODE', 'phase-overlap', at('skippable_phases'), `phase(s) both required and skippable: ${overlap.join(', ')}`));
    const missing = PHASES.filter((p) => !m.required_phases.includes(p) && !m.skippable_phases.includes(p));
    if (missing.length) errors.push(err('SDD_MODE', 'phase-unclassified', at('required_phases'), `phase(s) neither required nor skippable: ${missing.join(', ')}`));
    for (const p of ALWAYS_REQUIRED) if (!m.required_phases.includes(p)) errors.push(err('SDD_MODE', 'phase-required', at('required_phases'), `mode "${m.id}" must require "${p}"`));
    if (m.id === 'full' && m.skippable_phases.length) errors.push(err('SDD_MODE', 'full-skips', at('skippable_phases'), 'full mode must not skip any phase'));
    const bypassed = GATES.filter((g) => !m.applies_gates.includes(g));
    if (bypassed.length) errors.push(err('SDD_GATE', 'gate-bypass', at('applies_gates'), `mode "${m.id}" must apply every gate; missing: ${bypassed.join(', ')}`));
    for (const g of m.applies_gates) if (!GATES.includes(g)) errors.push(err('SDD_GATE', 'unknown-gate', at('applies_gates'), `unknown gate "${g}"`));
    for (const l of m.traceability) if (!LINKS.includes(l)) errors.push(err('SDD_TRACE', 'unknown-link', at('traceability'), `unknown traceability link "${l}"`));
    for (const l of m.id === 'full' ? LINKS : CORE_LINKS) if (!m.traceability.includes(l)) errors.push(err('SDD_TRACE', 'missing-link', at('traceability'), `mode "${m.id}" must trace "${l}"`));
    if (m.id === 'hotfix') {
      for (const t of HOTFIX_EXCLUDED) if (!m.excluded_change_types.includes(t)) errors.push(err('SDD_MODE', 'hotfix-scope', at('excluded_change_types'), `hotfix must exclude change type "${t}"`));
      if (m.max_tasks === undefined || m.max_tasks > 5) errors.push(err('SDD_MODE', 'hotfix-size', at('max_tasks'), 'hotfix must declare max_tasks of at most 5'));
    }
  });
  return errors;
}

// ---- agent map --------------------------------------------------------------
// agentDocs: Map(id -> agent manifest); primary: Set of primary agent ids (or null).
export function checkAgentMap(doc, { agentDocs, primary }) {
  const errors = [];
  const ids = doc.agents.map((a) => a.agent);
  for (const d of dupes(ids)) errors.push(err('SDD_TRACE', 'duplicate-agent', '$.agents', `agent "${d}" is mapped more than once`));
  const covered = new Set();
  doc.agents.forEach((a, i) => {
    const at = (f) => `$.agents[${i}].${f}`;
    const m = agentDocs.get(a.agent);
    if (!m) errors.push({ code: 'MISSING_REFERENCE', rule: 'sdd-agent', path: at('agent'), message: `agent "${a.agent}" is not defined` });
    for (const p of a.phases) { if (!PHASES.includes(p)) errors.push(err('SDD_TRACE', 'unknown-phase', at('phases'), `unknown phase "${p}"`)); else covered.add(p); }
    if (a.may_implement !== (a.role === 'implementer')) errors.push(err('SDD_GATE', 'implementer-flag', at('may_implement'), 'may_implement must be true exactly for the implementer role'));
    if (a.phases.includes('implement') && a.role !== 'implementer') errors.push(err('SDD_GATE', 'implement-phase-owner', at('phases'), `only implementers may be mapped to "implement" ("${a.agent}" is ${a.role})`));
    if (a.role === 'independent-validator' && !(a.phases.length === 1 && a.phases[0] === 'independent-validation')) errors.push(err('SDD_GATE', 'validator-phases', at('phases'), 'an independent validator may only be mapped to "independent-validation"'));
    if (a.phases.includes('independent-validation') && a.role !== 'independent-validator') errors.push(err('SDD_GATE', 'validation-phase-owner', at('phases'), `"${a.agent}" is ${a.role} and must not be mapped to "independent-validation"`));
    if (m) {
      if (a.role === 'implementer' && m.function !== 'implementer') errors.push(err('SDD_GATE', 'role-function', at('role'), `"${a.agent}" has function "${m.function}" and cannot be an implementer`));
      if (a.role === 'independent-validator' && !['reviewer', 'validator'].includes(m.function)) errors.push(err('SDD_GATE', 'role-function', at('role'), `"${a.agent}" has function "${m.function}" and cannot be an independent validator`));
      if (a.role === 'independent-validator' && m.read_only !== true) errors.push(err('SDD_GATE', 'role-function', at('role'), `independent validator "${a.agent}" must be read-only`));
      if (!['implementer', 'independent-validator'].includes(a.role) && m.function !== 'advisor') errors.push(err('SDD_GATE', 'role-function', at('role'), `"${a.agent}" has function "${m.function}" and must be an advisor for role "${a.role}"`));
    }
    if (a.agent === 'code-reviewer' && a.role !== 'independent-validator') errors.push(err('SDD_GATE', 'reviewer-independence', at('role'), 'code-reviewer must remain the independent validator and never an implementer'));
  });
  for (const p of PHASES) if (!covered.has(p)) errors.push(err('SDD_INCOMPLETE', 'phase-uncovered', '$.agents', `no agent is mapped to phase "${p}"`));
  if (!doc.agents.some((a) => a.role === 'independent-validator')) errors.push(err('SDD_GATE', 'no-validator', '$.agents', 'an independent validator must be mapped'));
  for (const p of primary ?? []) if (!ids.includes(p)) errors.push(err('SDD_INCOMPLETE', 'primary-unmapped', '$.agents', `primary agent "${p}" is not mapped`));
  // independence: the validator's manifest must declare independence from every mapped implementer
  for (const v of doc.agents.filter((a) => a.role === 'independent-validator')) {
    const declared = agentDocs.get(v.agent)?.independent_of;
    if (!Array.isArray(declared)) continue;
    for (const impl of doc.agents.filter((a) => a.role === 'implementer')) {
      if (!declared.includes(impl.agent)) errors.push(err('SDD_GATE', 'independence', '$.agents', `validator "${v.agent}" does not declare independence from implementer "${impl.agent}"`));
    }
  }
  return errors;
}

// ---- integration ------------------------------------------------------------
export function checkIntegration(doc, workflow) {
  const errors = [];
  const bad = (code, rule, path, message) => errors.push(err(code, rule, path, message));
  for (const [k, v] of Object.entries(SPEC_KIT_PIN)) {
    if (k === 'source') continue;
    if (doc.upstream[k] !== v) bad('SDD_PIN', 'pin-mismatch', `$.upstream.${k}`, `upstream.${k} does not match the verified pin`);
  }
  if (doc.install.source !== SPEC_KIT_PIN.source) bad('SDD_PIN', 'source-pin', '$.install.source', 'install source must be the exact verified release tag, not a branch or floating ref');
  if (doc.install.pinned !== true) bad('SDD_PIN', 'unpinned', '$.install.pinned', 'install must be pinned');
  if (doc.execution_allowed_in_this_phase !== false) bad('SDD_INTEGRATION', 'execution-allowed', '$.execution_allowed_in_this_phase', 'execution is not allowed in this phase');
  if (doc.status !== 'not-installed') bad('SDD_INTEGRATION', 'status', '$.status', 'status must be "not-installed" until an approved install is recorded');
  if (doc.test_status !== 'untested') bad('SDD_INTEGRATION', 'test-status', '$.test_status', 'test_status must be "untested" until tests are recorded');
  if (doc.install.auto_install !== false) bad('SDD_INTEGRATION', 'auto-install', '$.install.auto_install', 'automatic install is not allowed');
  if (doc.install.requires_approval !== true) bad('SDD_INTEGRATION', 'install-approval', '$.install.requires_approval', 'install must require approval');
  const init = doc.init;
  if (init.integration_flag_required !== true) bad('SDD_INTEGRATION', 'integration-flag', '$.init.integration_flag_required', 'init must require an explicit --integration key');
  if (init.non_interactive_flag !== '--non-interactive') bad('SDD_INTEGRATION', 'non-interactive', '$.init.non_interactive_flag', 'non-interactive flag must be "--non-interactive"');
  if (!init.command_template.includes('--integration') || /--force\b/.test(init.command_template)) bad('SDD_INTEGRATION', 'init-template', '$.init.command_template', 'init template must pass --integration and must not embed --force');
  if (init.force.flag !== '--force' || init.force.default !== false || init.force.requires_approval !== true) bad('SDD_INTEGRATION', 'force', '$.init.force', '--force must default to false and require approval');
  for (const p of PRECONDITIONS) if (!init.existing_project_preconditions.includes(p)) bad('SDD_INTEGRATION', 'precondition', '$.init.existing_project_preconditions', `existing-project precondition "${p}" is required`);
  const paths = doc.managed_paths.paths;
  paths.forEach((p, i) => {
    const at = `$.managed_paths.paths[${i}]`;
    if (!isSafeRel(p)) bad('SDD_INTEGRATION', 'managed-path', at, 'managed paths must be relative and must not contain ".."');
    else if (BROAD.test(p.trim()) || p.trim().startsWith('*')) bad('SDD_INTEGRATION', 'managed-path', at, 'managed path is overly broad');
    else if (within(p, '.git') || within(p, '.github')) bad('SDD_INTEGRATION', 'managed-path', at, 'managed paths must not cover version-control or CI configuration');
  });
  for (const d of dupes(paths.map(norm))) bad('SDD_INTEGRATION', 'managed-path', '$.managed_paths.paths', `duplicate managed path "${d}"`);
  if (doc.managed_paths.verification === 'verified' && doc.status === 'not-installed') bad('SDD_INTEGRATION', 'managed-path-verification', '$.managed_paths.verification', 'managed paths cannot be verified before an install');
  if (doc.conflict_detection.enabled !== true || doc.conflict_detection.report_required_before_write !== true) bad('SDD_INTEGRATION', 'conflict-detection', '$.conflict_detection', 'conflict detection and a pre-write conflict report are required');
  if (doc.backup.required !== true || doc.backup.before_any_write !== true) bad('SDD_INTEGRATION', 'backup', '$.backup', 'a backup before any write is required');
  if (doc.rollback.verify_after !== true) bad('SDD_INTEGRATION', 'rollback', '$.rollback.verify_after', 'rollback must be verified');
  if (workflow && !same(doc.workflow_order, workflow.phases.map((p) => p.id))) bad('SDD_TRACE', 'workflow-order', '$.workflow_order', 'workflow_order must equal the canonical workflow phases');
  return errors;
}

// ---- project ----------------------------------------------------------------
// ctx: { workflow, agentMap, projectFile, root }
export function checkProject(doc, { workflow, agentMap, projectFile, root }) {
  const errors = [];
  const add = (code, rule, path, message) => errors.push(err(code, rule, path, message));
  const mode = workflow.modes.find((m) => m.id === doc.mode);
  if (!mode) { add('SDD_MODE', 'unknown-mode', '$.mode', `mode "${doc.mode}" is not defined by the workflow`); return errors; }
  const order = workflow.phases.map((p) => p.id);
  const idx = (p) => order.indexOf(p);

  // phases and mode rules
  const known = (list, path) => list.filter((p, i) => { if (idx(p) < 0) { add('SDD_MODE', 'unknown-phase', `${path}[${i}]`, `unknown phase "${p}"`); return false; } return true; });
  const completed = known(doc.completed_phases, '$.completed_phases');
  const skipped = known(doc.skipped_phases.map((s) => s.phase), '$.skipped_phases');
  doc.skipped_phases.forEach((s, i) => {
    if (idx(s.phase) < 0) return;
    if (mode.required_phases.includes(s.phase)) add('SDD_MODE', 'required-phase-skipped', `$.skipped_phases[${i}]`, `phase "${s.phase}" is required in ${mode.id} mode and cannot be skipped`);
    else if (!mode.skippable_phases.includes(s.phase)) add('SDD_MODE', 'phase-not-skippable', `$.skipped_phases[${i}]`, `phase "${s.phase}" is not skippable in ${mode.id} mode`);
  });
  for (const p of completed) if (skipped.includes(p)) add('SDD_MODE', 'phase-both', '$.completed_phases', `phase "${p}" is both completed and skipped`);
  for (const p of completed) {
    const unmet = mode.required_phases.filter((r) => idx(r) < idx(p) && !completed.includes(r));
    if (unmet.length) add('SDD_MODE', 'phase-order', '$.completed_phases', `phase "${p}" completed before required phase(s): ${unmet.join(', ')}`);
  }
  for (const t of doc.tasks) if (mode.excluded_change_types.includes(t.change_type)) add('SDD_MODE', 'excluded-change-type', `$.tasks`, `${mode.id} mode must not cover change type "${t.change_type}" (task "${t.id}")`);
  if (mode.max_tasks !== undefined && doc.tasks.length > mode.max_tasks) add('SDD_MODE', 'max-tasks', '$.tasks', `${mode.id} mode allows at most ${mode.max_tasks} task(s)`);

  // identity
  const sections = { requirements: doc.requirements, 'acceptance-criteria': doc.acceptance_criteria, decisions: doc.decisions, tasks: doc.tasks, risks: doc.risks };
  for (const [name, list] of Object.entries(sections)) for (const d of dupes(list.map((x) => x.id))) add('SDD_TRACE', 'duplicate-id', `$.${name.replace('-', '_')}`, `duplicate id "${d}"`);
  const reqs = new Map(doc.requirements.map((r) => [r.id, r]));
  const crits = new Map(doc.acceptance_criteria.map((c) => [c.id, c]));
  const taskIds = new Set(doc.tasks.map((t) => t.id));

  // artifact contracts: every item carries every required field, non-empty
  const started = doc.tasks.some((t) => t.status !== 'planned') || doc.files_changed.length > 0 || completed.includes('implement');
  for (const c of workflow.artifact_contracts) {
    const items = COLLECTIONS[c.id]?.(doc);
    if (!Array.isArray(items)) continue;
    items.forEach((item, i) => {
      for (const f of c.required_fields) {
        const v = item[f.replace(/-/g, '_')];
        const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
        if (empty) add('SDD_INCOMPLETE', 'artifact-field', `$.${COLLECTIONS_PATH[c.id]}[${i}]`, `${c.id} item "${item.id ?? i}" is missing required "${f}"`);
      }
    });
  }
  if ((completed.includes('specify') || started) && doc.requirements.length === 0) add('SDD_INCOMPLETE', 'no-requirements', '$.requirements', 'a specified project must declare at least one requirement');
  if ((completed.includes('tasks') || started) && doc.tasks.length === 0) add('SDD_INCOMPLETE', 'no-tasks', '$.tasks', 'a planned project must declare at least one task');
  if (completed.includes('clarify') || started) {
    doc.requirements.forEach((r, i) => { if (r.open_questions.length) add('SDD_INCOMPLETE', 'open-questions', `$.requirements[${i}].open_questions`, `requirement "${r.id}" has unresolved open questions`); });
  }

  // traceability (references are always checked; coverage depends on mode and progress)
  const has = (l) => mode.traceability.includes(l);
  doc.requirements.forEach((r, i) => r.acceptance_criteria.forEach((cid) => {
    const c = crits.get(cid);
    if (!c) add('SDD_TRACE', 'broken-ref', `$.requirements[${i}].acceptance_criteria`, `acceptance criterion "${cid}" is not defined`);
    else if (c.requirement !== r.id && has('requirement-to-criterion')) add('SDD_TRACE', 'criterion-backlink', `$.requirements[${i}].acceptance_criteria`, `criterion "${cid}" belongs to requirement "${c.requirement}"`);
  }));
  doc.acceptance_criteria.forEach((c, i) => {
    const r = reqs.get(c.requirement);
    if (!r) add('SDD_TRACE', 'broken-ref', `$.acceptance_criteria[${i}].requirement`, `requirement "${c.requirement}" is not defined`);
    else if (has('requirement-to-criterion') && !r.acceptance_criteria.includes(c.id)) add('SDD_TRACE', 'requirement-backlink', `$.acceptance_criteria[${i}].requirement`, `requirement "${r.id}" does not list criterion "${c.id}"`);
  });
  doc.decisions.forEach((d, i) => d.requirements.forEach((rid) => { if (!reqs.has(rid)) add('SDD_TRACE', 'broken-ref', `$.decisions[${i}].requirements`, `requirement "${rid}" is not defined`); }));
  if (has('decision-to-requirement') && completed.includes('plan')) {
    for (const r of doc.requirements) if (!doc.decisions.some((d) => d.requirements.includes(r.id))) add('SDD_TRACE', 'requirement-without-decision', '$.decisions', `requirement "${r.id}" is not served by any technical decision`);
  }
  doc.tasks.forEach((t, i) => {
    const at = (f) => `$.tasks[${i}].${f}`;
    for (const rid of t.requirements) if (!reqs.has(rid)) add('SDD_TRACE', 'broken-ref', at('requirements'), `requirement "${rid}" is not defined`);
    for (const cid of t.acceptance_criteria) {
      const c = crits.get(cid);
      if (!c) add('SDD_TRACE', 'broken-ref', at('acceptance_criteria'), `acceptance criterion "${cid}" is not defined`);
      else if (has('task-to-criterion') && !t.requirements.includes(c.requirement)) add('SDD_TRACE', 'criterion-requirement-mismatch', at('acceptance_criteria'), `criterion "${cid}" belongs to requirement "${c.requirement}", which task "${t.id}" does not reference`);
    }
  });
  if (has('task-to-requirement') && (completed.includes('tasks') || started)) {
    for (const r of doc.requirements) if (!doc.tasks.some((t) => t.requirements.includes(r.id))) add('SDD_TRACE', 'requirement-without-task', '$.tasks', `requirement "${r.id}" is not covered by any task`);
  }
  doc.risks.forEach((r, i) => {
    for (const tid of r.tasks) if (!taskIds.has(tid)) add('SDD_TRACE', 'broken-ref', `$.risks[${i}].tasks`, `task "${tid}" is not defined`);
    if (has('risk-to-task') && r.severity === 'high' && r.tasks.length === 0) add('SDD_TRACE', 'risk-without-task', `$.risks[${i}].tasks`, `high risk "${r.id}" is not linked to a task`);
  });
  doc.validation.evidence.forEach((ev, i) => ev.criteria.forEach((cid) => { if (!crits.has(cid)) add('SDD_TRACE', 'broken-ref', `$.validation.evidence[${i}].criteria`, `acceptance criterion "${cid}" is not defined`); }));

  // owners
  const agents = new Map(agentMap.agents.map((a) => [a.agent, a]));
  doc.tasks.forEach((t, i) => {
    const a = agents.get(t.owner);
    if (!a) add('SDD_TRACE', 'unknown-owner', `$.tasks[${i}].owner`, `owner "${t.owner}" is not mapped to any SDD role`);
    else if (!a.may_implement) add('SDD_GATE', 'owner-not-implementer', `$.tasks[${i}].owner`, `"${t.owner}" (${a.role}) may not own implementation tasks`);
  });

  // scope
  const allowed = doc.scope.allowed_paths;
  const prohibited = doc.scope.prohibited_paths;
  const inScope = (p) => allowed.some((a) => within(p, a)) && !prohibited.some((x) => within(p, x));
  const scopeCheck = (p, path, what) => {
    if (!isSafeRel(p)) { add('SDD_SCOPE', 'unsafe-path', path, `${what} path must be relative without ".."`); return false; }
    if (!inScope(p)) { add('SDD_SCOPE', 'out-of-scope', path, `${what} "${p}" is outside the declared scope`); return false; }
    return true;
  };
  doc.tasks.forEach((t, i) => t.paths.forEach((p, j) => scopeCheck(p, `$.tasks[${i}].paths[${j}]`, `task path`)));
  const planned = doc.tasks.flatMap((t) => t.paths);
  doc.files_changed.forEach((f, i) => {
    if (!scopeCheck(f, `$.files_changed[${i}]`, 'changed file')) return;
    if (!planned.some((p) => within(f, p))) add('SDD_SCOPE', 'unplanned-change', `$.files_changed[${i}]`, `changed file "${f}" is not covered by any task`);
  });

  // milestones: additive and read-only
  if (doc.milestone_ref !== undefined) {
    const m = doc.milestone_ref;
    if (isSafeRel(m)) {
      if ([...planned, ...doc.files_changed, ...allowed].some((p) => within(m, p) || within(p, m))) add('SDD_SCOPE', 'milestone-write', '$.milestone_ref', 'milestone files are read-only and must not be in task paths, changed files or the allowed scope');
      const target = join(dirname(projectFile), m);
      let ok = false;
      try { ok = !confine(target, root) && lstatSync(target).isFile(); } catch { ok = false; }
      if (!ok) errors.push({ code: 'MISSING_REFERENCE', rule: 'milestone-ref', path: '$.milestone_ref', message: `milestone file not found: ${m}` });
    }
  }

  // gates
  const approved = (g) => doc.approvals.some((a) => a.gate === g && a.granted === true);
  doc.approvals.forEach((a, i) => { if (!GATES.includes(a.gate)) add('SDD_GATE', 'unknown-gate', `$.approvals[${i}].gate`, `unknown gate "${a.gate}"`); });
  const gateErr = (rule, message) => add('SDD_GATE', rule, '$.approvals', message);
  if (started) {
    if (!approved('pre-implementation')) gateErr('implementation-without-approval', 'implementation has started without a granted human approval for gate "pre-implementation"');
    const unmet = mode.required_phases.filter((r) => idx(r) < idx('implement') && !completed.includes(r));
    if (unmet.length) gateErr('prerequisite-phases', `implementation started before required phase(s) completed: ${unmet.join(', ')}`);
  }
  doc.tasks.forEach((t, i) => {
    if (t.status === 'planned') return;
    for (const g of CHANGE_GATES[t.change_type] ?? []) if (!approved(g)) add('SDD_GATE', 'missing-approval', `$.tasks[${i}].change_type`, `task "${t.id}" (${t.change_type}) started without a granted approval for gate "${g}"`);
    if (ROLLBACK_TYPES.has(t.change_type) && !doc.risks.some((r) => r.tasks.includes(t.id) && r.mitigation.trim() !== '')) add('SDD_GATE', 'rollback-plan', `$.tasks[${i}]`, `task "${t.id}" (${t.change_type}) requires a recorded risk with a mitigation or rollback plan`);
    if (t.change_type === 'deployment' && doc.validation.validation_result !== 'PASS') add('SDD_GATE', 'deploy-before-validation', `$.tasks[${i}]`, `deployment task "${t.id}" started before an independent PASS`);
  });

  // validation / PASS gate
  const v = doc.validation;
  const val = (rule, message, path = '$.validation') => add('SDD_GATE', rule, path, message);
  if (v.validation_result === 'PASS') {
    const validator = agents.get(v.validated_by);
    const owners = new Set(doc.tasks.map((t) => t.owner));
    if (owners.has(v.validated_by) || validator?.role === 'implementer') val('implementer-validation', `"${v.validated_by}" implemented work and cannot validate it`, '$.validation.validated_by');
    else if (validator?.role !== 'independent-validator') val('independent-validation', 'PASS requires an independent validator mapped by the agent map', '$.validation.validated_by');
    if (!hasUsefulEvidence(v.evidence)) val('pass-without-evidence', 'PASS requires at least one evidence item with a meaningful description', '$.validation.evidence');
    const covered = new Set(v.evidence.filter((ev) => hasUsefulEvidence([ev])).flatMap((ev) => ev.criteria));
    for (const c of doc.acceptance_criteria) if (!covered.has(c.id)) add('SDD_TRACE', 'uncovered-criterion', '$.validation.evidence', `acceptance criterion "${c.id}" has no useful evidence`);
    if (doc.acceptance_criteria.length === 0) add('SDD_INCOMPLETE', 'no-criteria', '$.acceptance_criteria', 'PASS requires at least one acceptance criterion');
    if (doc.tasks.some((t) => t.status !== 'done') || doc.tasks.length === 0) val('tasks-not-done', 'PASS requires at least one task and every task done');
    const unmet = mode.required_phases.filter((r) => r !== 'independent-validation' && !completed.includes(r));
    if (unmet.length) val('prerequisite-phases', `PASS requires required phase(s) completed: ${unmet.join(', ')}`, '$.completed_phases');
  } else if (completed.includes('independent-validation')) {
    val('validation-state', 'independent-validation cannot be completed without a PASS result', '$.completed_phases');
  }
  return errors;
}

const COLLECTIONS_PATH = { requirements: 'requirements', 'acceptance-criteria': 'acceptance_criteria', 'technical-decisions': 'decisions', tasks: 'tasks', risks: 'risks', 'validation-evidence': 'validation.evidence' };
