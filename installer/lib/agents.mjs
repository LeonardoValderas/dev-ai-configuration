// Agent / catalog policy checks. Pure functions over parsed JSON; no I/O.
// Complements schema validation and checks.mjs (dangerous grants, paths, secrets).
import { collectStrings } from './checks.mjs';

const WRITE_TOOL = /^(write|edit|multiedit|notebookedit|bash|shell|terminal)\b/i;
const READONLY_SHELL = /^git (diff|status|log|show)( [A-Za-z0-9_.\/@^~:=-]+)*$/;
const VALIDATION_SHELL = /^npm (test|run validate)$/;
const OPENCLAW = /open[-_ ]?claw/i;
const INDEPENDENT_FUNCTIONS = new Set(['reviewer', 'validator']);
const REQUIRED_PORTABLE = ['function', 'read_only', 'contracts', 'activation', 'limits'];

const policy = (rule, path, message) => ({ code: 'AGENT_POLICY', rule, path, message });

// Portable catalogs and agents must not depend on the OpenClaw runtime.
export function checkRuntimeCoupling(doc) {
  return collectStrings(doc)
    .filter(({ value }) => OPENCLAW.test(value))
    .map(({ path }) => ({ code: 'RUNTIME_COUPLING', rule: 'openclaw', path, message: 'portable definitions must not reference the OpenClaw runtime' }));
}

export function checkInstructionsCoupling(text) {
  return OPENCLAW.test(text)
    ? [{ code: 'RUNTIME_COUPLING', rule: 'openclaw', path: '$.instructions_path', message: 'instructions must not reference the OpenClaw runtime' }]
    : [];
}

// strict: the manifest is linked from the catalog, so all portable fields are required.
export function checkAgentPolicy(doc, { strict = false } = {}) {
  const errors = [];
  const perms = doc.permissions ?? {};
  const tools = Array.isArray(perms.tools) ? perms.tools : [];
  const shell = Array.isArray(perms.shell_commands) ? perms.shell_commands : [];
  const writable = Array.isArray(perms.writable_paths) ? perms.writable_paths : [];

  if (strict) {
    for (const f of REQUIRED_PORTABLE) {
      if (doc[f] === undefined) errors.push(policy('missing-portable-field', `$.${f}`, `catalog agents must declare "${f}"`));
    }
    if (perms.production_access !== 'none') errors.push(policy('production-access', '$.permissions.production_access', 'catalog agents must set production_access "none"'));
    if (tools.length === 0) errors.push(policy('missing-portable-field', '$.permissions.tools', 'catalog agents must list explicit tools'));
  }

  const fn = doc.function;
  if (fn && fn !== 'implementer' && doc.read_only !== true) {
    errors.push(policy('read-only-required', '$.read_only', `function "${fn}" must be read_only`));
  }
  if (doc.read_only === true) {
    tools.forEach((t, i) => { if (typeof t === 'string' && WRITE_TOOL.test(t.trim())) errors.push(policy('read-only-violation', `$.permissions.tools[${i}]`, `read-only agent must not hold write/shell tool "${t}"`)); });
    if (writable.length) errors.push(policy('read-only-violation', '$.permissions.writable_paths', 'read-only agent must not declare writable_paths'));
    shell.forEach((c, i) => {
      const ok = typeof c === 'string' && (READONLY_SHELL.test(c.trim()) || (fn === 'validator' && VALIDATION_SHELL.test(c.trim())));
      if (!ok) errors.push(policy('read-only-violation', `$.permissions.shell_commands[${i}]`, 'read-only agent may only run read-only git commands (validators may also run npm test / npm run validate)'));
    });
    if (perms.permission_mode !== undefined && perms.permission_mode !== 'plan') errors.push(policy('read-only-violation', '$.permissions.permission_mode', 'read-only agent must use permission_mode "plan"'));
    if (doc.limits?.max_files_changed !== undefined && doc.limits.max_files_changed !== 0) errors.push(policy('limits', '$.limits.max_files_changed', 'read-only agent must have max_files_changed 0'));
  }
  if (fn === 'implementer') {
    if (doc.limits && !(doc.limits.max_files_changed >= 1)) errors.push(policy('limits', '$.limits.max_files_changed', 'implementer must declare max_files_changed >= 1'));
    if (strict && writable.length === 0) errors.push(policy('missing-portable-field', '$.permissions.writable_paths', 'implementer must declare scoped writable_paths'));
    if (doc.independent_of?.length) errors.push(policy('independence', '$.independent_of', 'only reviewers and validators declare independent_of'));
  }
  if (INDEPENDENT_FUNCTIONS.has(fn)) {
    if (!doc.independent_of?.length) errors.push(policy('independence', '$.independent_of', `${fn} must declare independent_of (the implementers it reviews)`));
    if (doc.independent_of?.includes(doc.id)) errors.push(policy('independence', '$.independent_of', 'agent cannot be independent of itself'));
  }
  return errors;
}

// agents: Map id -> manifest doc (schema-valid manifests only).
export function checkCatalog(catalog, agents) {
  const errors = [];
  const list = catalog.agents;
  const seen = new Set();
  const byId = new Map();
  list.forEach((e, i) => {
    if (seen.has(e.id)) errors.push({ code: 'DUPLICATE_ID', path: `$.agents[${i}].id`, message: `duplicate catalog entry "${e.id}"` });
    seen.add(e.id);
    byId.set(e.id, e);
  });
  if (list.length !== catalog.expected.total) errors.push(policy('catalog-count', '$.agents', `catalog lists ${list.length} agents, expected ${catalog.expected.total}`));
  const primaries = list.filter((e) => e.classification === 'primary').length;
  if (primaries !== catalog.expected.primary) errors.push(policy('catalog-count', '$.agents', `catalog lists ${primaries} primary agents, expected ${catalog.expected.primary}`));

  list.forEach((e, i) => {
    const p = `$.agents[${i}]`;
    if (e.classification === 'redundant') {
      if (agents.has(e.id)) errors.push(policy('redundant-has-manifest', `${p}.id`, `redundant agent "${e.id}" must not have a portable manifest`));
      if (!e.superseded_by) errors.push(policy('classification', `${p}.superseded_by`, 'redundant agent must name superseded_by'));
      else if (byId.get(e.superseded_by)?.classification !== 'primary') errors.push({ code: 'MISSING_REFERENCE', rule: 'catalog-superseded-by', path: `${p}.superseded_by`, message: `primary agent "${e.superseded_by}" is not in the catalog` });
    } else {
      if (e.superseded_by) errors.push(policy('classification', `${p}.superseded_by`, 'only redundant agents may declare superseded_by'));
      if (!agents.has(e.id)) errors.push({ code: 'MISSING_REFERENCE', rule: 'catalog-manifest', path: `${p}.id`, message: `agent manifest "${e.id}" is not defined` });
    }
  });
  for (const id of agents.keys()) {
    const entry = byId.get(id);
    if (!entry) errors.push(policy('orphan-manifest', '$.agents', `agent manifest "${id}" is not listed in the catalog`));
  }
  const reviewer = byId.get('code-reviewer');
  if (!reviewer || reviewer.classification === 'redundant') errors.push(policy('code-reviewer-read-only', '$.agents', 'catalog must list code-reviewer as a primary or optional agent'));
  else {
    const m = agents.get('code-reviewer');
    if (m && !(m.read_only === true && m.function === 'reviewer')) errors.push(policy('code-reviewer-read-only', '$.agents', 'code-reviewer must be a read_only reviewer'));
  }
  // independence: reviewers/validators must point at catalog implementers
  for (const [id, m] of agents) {
    (m.independent_of ?? []).forEach((ref) => {
      const target = agents.get(ref);
      // undefined targets are reported by the generic reference check
      if (target && target.function !== 'implementer') errors.push(policy('independence', `$.agents.${id}.independent_of`, `"${ref}" is not an implementer`));
    });
  }
  return errors;
}
