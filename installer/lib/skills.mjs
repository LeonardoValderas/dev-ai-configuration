// Skill / skill-catalog policy checks. Pure functions over parsed JSON and text; no I/O.
import { collectStrings, scanSecrets, COMMAND_RULES, ABS_ANYWHERE } from './checks.mjs';

const WRITE_TOOL = /^(write|edit|multiedit|notebookedit|bash|shell|terminal)\b/i;
const READONLY_SHELL = /^git (diff|status|log|show)( [A-Za-z0-9_.\/@^~:=-]+)*$/;
const OPENCLAW = /open[-_ ]?claw/i;
const EXCLUDED = /context[-_ ]?7|spec[-_ ]?kit/i;
const APPROVED = new Set(['CORE', 'OPTIONAL']);
const LICENSE_OK = new Set(['verified-license-file', 'verified-upstream', 'declared-spdx']);
const EVIDENCE_FOR = { 'verified-license-file': 'license-file', 'verified-upstream': 'upstream-verified', 'declared-spdx': 'frontmatter-declaration' };
const PROVENANCE_FIELDS = ['source_url', 'source_commit', 'source_path', 'license_url', 'copyright', 'license_scope'];
const REQUIRED_PORTABLE = ['activation', 'auto_enable', 'risk', 'license', 'dependencies', 'adapters'];
const ADAPTERS = ['claude-code', 'codex', 'cursor'];

const policy = (rule, path, message) => ({ code: 'SKILL_POLICY', rule, path, message });

// Verified-upstream evidence is RECORDED provenance (URLs and a pinned commit entered by a
// reviewer). Nothing here contacts the network or proves the upstream state at run time.
export function checkProvenance(license, where, { needsFile = false } = {}) {
  const errors = [];
  const pr = license?.provenance;
  if (!pr) { errors.push(policy('provenance', `${where}.provenance`, 'verified-upstream licenses must record provenance (source URL, pinned commit, source path, license URL, copyright)')); return errors; }
  for (const f of PROVENANCE_FIELDS) if (typeof pr[f] !== 'string' || !pr[f].trim()) errors.push(policy('provenance', `${where}.provenance.${f}`, `provenance must record "${f}"`));
  if (!license.spdx) errors.push(policy('provenance', `${where}.spdx`, 'verified-upstream licenses must record the SPDX id'));
  if (typeof pr.source_commit === 'string' && !/^[0-9a-f]{40}$/.test(pr.source_commit)) errors.push(policy('provenance', `${where}.provenance.source_commit`, 'source_commit must be a full 40-character lowercase hex commit id'));
  for (const f of ['source_url', 'license_url']) if (typeof pr[f] === 'string' && !/^https:\/\/[^\s]+$/.test(pr[f])) errors.push(policy('provenance', `${where}.provenance.${f}`, `${f} must be an https URL`));
  if (typeof pr.source_path === 'string' && (pr.source_path.startsWith('/') || pr.source_path.split('/').includes('..'))) errors.push(policy('provenance', `${where}.provenance.source_path`, 'source_path must be a relative path inside the upstream repository'));
  if (needsFile && !license.license_path) errors.push(policy('provenance', `${where}.license_path`, 'verified-upstream licenses must ship the full license text (license_path)'));
  return errors;
}

export const isExternal = (m) => (m?.dependencies?.external_services?.length ?? 0) > 0 || m?.dependencies?.requires_credentials === true || (m?.requires_mcp?.length ?? 0) > 0;

// strict: the manifest is linked from the catalog as CORE or OPTIONAL.
export function checkSkillPolicy(doc, { strict = false } = {}) {
  const errors = [];
  const perms = doc.permissions ?? {};
  const tools = Array.isArray(perms.tools) ? perms.tools : [];
  const shell = Array.isArray(perms.shell_commands) ? perms.shell_commands : [];
  const writable = Array.isArray(perms.writable_paths) ? perms.writable_paths : [];
  if (strict) {
    for (const f of REQUIRED_PORTABLE) if (doc[f] === undefined) errors.push(policy('missing-portable-field', `$.${f}`, `catalog skills must declare "${f}"`));
    if (doc.permissions === undefined || tools.length === 0) errors.push(policy('missing-portable-field', '$.permissions.tools', 'catalog skills must list explicit tools'));
    if (perms.production_access !== 'none') errors.push(policy('production-access', '$.permissions.production_access', 'catalog skills must set production_access "none"'));
    for (const a of ADAPTERS) if (doc.adapters && doc.adapters[a] === undefined) errors.push(policy('adapter-claim', `$.adapters.${a}`, `adapter status for "${a}" must be stated explicitly`));
    if (!doc.reference_paths && !doc.instructions_path) errors.push(policy('missing-portable-field', '$.instructions_path', 'catalog skills must have instructions'));
  }
  if (doc.auto_enable !== undefined && doc.auto_enable !== false) errors.push(policy('auto-enable', '$.auto_enable', 'skills must never auto-enable'));
  if (perms.permission_mode !== undefined && !['default', 'plan'].includes(perms.permission_mode)) errors.push(policy('permission-mode', '$.permissions.permission_mode', 'skills may only require permission_mode "default" or "plan"'));
  shell.forEach((c, i) => {
    if (!(typeof c === 'string' && READONLY_SHELL.test(c.trim()))) errors.push(policy('skill-shell', `$.permissions.shell_commands[${i}]`, 'skills may only require read-only git commands'));
  });
  const writes = tools.some((t) => typeof t === 'string' && WRITE_TOOL.test(t.trim()));
  if (writes && strict && writable.length === 0) errors.push(policy('missing-portable-field', '$.permissions.writable_paths', 'a skill with write tools must declare scoped writable_paths'));
  if (!writes && writable.length) errors.push(policy('read-only-violation', '$.permissions.writable_paths', 'a skill without write tools must not declare writable_paths'));
  if (strict && isExternal(doc) && doc.risk === 'low') errors.push(policy('risk-level', '$.risk', 'a skill with external services, credentials or MCP must not be risk "low"'));
  if (doc.license?.evidence === 'upstream-verified') errors.push(...checkProvenance(doc.license, '$.license', { needsFile: true }));
  else if (doc.license && (doc.license.provenance || doc.license.license_path)) errors.push(policy('provenance', '$.license.evidence', 'provenance and license_path are only valid with evidence "upstream-verified"'));
  if (strict && doc.license && doc.license.spdx === undefined) errors.push(policy('license', '$.license.spdx', 'license must name an SPDX id'));
  return errors;
}

// skills: Map id -> manifest doc (schema-valid manifests only).
export function checkSkillCatalog(catalog, skills) {
  const errors = [];
  const list = catalog.skills;
  const byId = new Map();
  const seen = new Set();
  list.forEach((e, i) => {
    if (seen.has(e.id)) errors.push({ code: 'DUPLICATE_ID', path: `$.skills[${i}].id`, message: `duplicate catalog entry "${e.id}"` });
    seen.add(e.id);
    byId.set(e.id, e);
  });
  const count = (c) => list.filter((e) => e.classification === c).length;
  const want = catalog.expected;
  if (list.length !== want.total) errors.push(policy('catalog-count', '$.skills', `catalog lists ${list.length} skills, expected ${want.total}`));
  for (const [cls, key] of [['CORE', 'core'], ['OPTIONAL', 'optional'], ['QUARANTINED', 'quarantined'], ['DEPRECATED', 'deprecated']]) {
    if (count(cls) !== want[key]) errors.push(policy('catalog-count', '$.skills', `catalog lists ${count(cls)} ${cls} skills, expected ${want[key]}`));
  }
  if (want.core + want.optional + want.quarantined + want.deprecated !== want.total) errors.push(policy('catalog-count', '$.expected', 'expected class counts do not add up to total'));

  list.forEach((e, i) => {
    const p = `$.skills[${i}]`;
    if (e.origin.path !== `claude/global/skills/${e.id}/SKILL.md`) errors.push(policy('origin', `${p}.origin.path`, 'origin path must be the skill\'s own SKILL.md'));
    const m = skills.get(e.id);
    if (APPROVED.has(e.classification)) {
      if (!LICENSE_OK.has(e.license.status)) errors.push(policy('license-unverified', `${p}.license.status`, `${e.classification} skills need a verifiable license (verified-license-file, verified-upstream or declared-spdx); otherwise quarantine`));
      else if (e.license.status === 'verified-upstream') errors.push(...checkProvenance(e.license, `${p}.license`));
      if (LICENSE_OK.has(e.license.status) && e.license.status !== 'verified-upstream' && e.license.provenance) errors.push(policy('provenance', `${p}.license.status`, 'provenance is only valid with status "verified-upstream"'));
      if (LICENSE_OK.has(e.license.status) && !e.license.spdx) errors.push(policy('license-unverified', `${p}.license.spdx`, 'approved skills must record the SPDX id'));
      if (e.classification === 'CORE' && (e.dependencies.external_services.length || e.dependencies.requires_credentials)) errors.push(policy('core-external', `${p}.dependencies`, 'CORE skills must not need external services or credentials (at most OPTIONAL)'));
      if (e.superseded_by) errors.push(policy('classification', `${p}.superseded_by`, 'only deprecated skills may declare superseded_by'));
      if (!m) errors.push({ code: 'MISSING_REFERENCE', rule: 'catalog-manifest', path: `${p}.id`, message: `skill manifest "${e.id}" is not defined` });
      else {
        if (e.classification === 'CORE' && isExternal(m)) errors.push(policy('core-external', `$.skills.${e.id}`, 'CORE skill manifest must not declare external services, credentials or MCP'));
        if (m.license && m.license.spdx !== e.license.spdx) errors.push(policy('license-mismatch', `$.skills.${e.id}.license.spdx`, 'manifest and catalog license differ'));
        if (m.license && m.license.evidence !== EVIDENCE_FOR[e.license.status]) errors.push(policy('license-mismatch', `$.skills.${e.id}.license.evidence`, 'manifest license evidence does not match the catalog license status'));
        if (e.license.status === 'verified-upstream' && JSON.stringify(m.license?.provenance ?? null) !== JSON.stringify(e.license.provenance ?? null)) errors.push(policy('license-mismatch', `$.skills.${e.id}.license.provenance`, 'manifest and catalog provenance differ'));
        const a = (x) => JSON.stringify([...(x ?? [])].sort());
        if (a(m.dependencies?.external_services) !== a(e.dependencies.external_services) || (m.dependencies?.requires_credentials ?? false) !== e.dependencies.requires_credentials) errors.push(policy('dependency-mismatch', `$.skills.${e.id}.dependencies`, 'manifest and catalog dependencies differ'));
        for (const d of m.dependencies?.skills ?? []) {
          if (!APPROVED.has(byId.get(d)?.classification)) errors.push(policy('dependency-not-approved', `$.skills.${e.id}.dependencies.skills`, `dependency "${d}" is not an approved (CORE/OPTIONAL) skill`));
        }
      }
    } else {
      if (m) errors.push(policy('quarantined-has-manifest', `${p}.id`, `${e.classification} skill "${e.id}" must not have a portable manifest or instructions`));
      if (e.classification === 'QUARANTINED' && e.risks.length === 0) errors.push(policy('quarantine-reason', `${p}.risks`, 'quarantined skills must document why'));
      if (e.classification === 'DEPRECATED') {
        if (!e.superseded_by) errors.push(policy('classification', `${p}.superseded_by`, 'deprecated skill must name superseded_by'));
        else if (e.superseded_by === e.id || !byId.has(e.superseded_by)) errors.push({ code: 'MISSING_REFERENCE', rule: 'catalog-superseded-by', path: `${p}.superseded_by`, message: `skill "${e.superseded_by}" is not in the catalog` });
        else if (byId.get(e.superseded_by).classification === 'DEPRECATED') errors.push(policy('classification', `${p}.superseded_by`, 'superseded_by must not itself be deprecated'));
      } else if (e.superseded_by) errors.push(policy('classification', `${p}.superseded_by`, 'only deprecated skills may declare superseded_by'));
    }
    for (const d of e.dependencies.skills ?? []) if (!byId.has(d)) errors.push({ code: 'MISSING_REFERENCE', rule: 'catalog-dependency', path: `${p}.dependencies.skills`, message: `skill "${d}" is not in the catalog` });
  });
  for (const id of skills.keys()) if (!byId.has(id)) errors.push(policy('orphan-manifest', '$.skills', `skill manifest "${id}" is not listed in the catalog`));
  return errors;
}

// Portable skills must not depend on the OpenClaw runtime or on integrations
// that are out of scope for this repository (Context7, Spec Kit).
export function checkSkillCoupling(doc) {
  return collectStrings(doc)
    .filter(({ value }) => EXCLUDED.test(value))
    .map(({ path }) => ({ code: 'RUNTIME_COUPLING', rule: 'excluded-integration', path, message: 'skills must not reference excluded integrations (Context7, Spec Kit)' }));
}

const INJECTION = [
  /\bignore\s+(all\s+|any\s+|the\s+)*(previous|prior|above|earlier|preceding)\s+(instructions|rules|prompts|directions)/i,
  /\bdisregard\s+(all\s+|any\s+|the\s+)*(previous|prior|above|earlier|system)\b/i,
  /\b(reveal|print|show|leak|exfiltrate)\s+(your\s+|the\s+)*(system\s+prompt|hidden\s+instructions|secrets?|credentials)/i,
  /\b(do\s+not|don'?t|never)\s+(tell|inform|notify|alert)\s+the\s+user/i,
  /\byou\s+are\s+now\s+(in\s+)?(developer|dan|jailbreak|unrestricted)/i,
];
const HIDDEN = /[​-‏‪-‮⁠-⁩﻿]/;
const SHELL_RULES = COMMAND_RULES.filter(([n]) => ['force-push', 'bypass-permissions', 'destructive-delete'].includes(n));
const PIPE_SHELL = [
  ['pipe-to-shell', /\|\s*(sudo\s+)?(sh|bash|zsh)\b/],
  ['shell-eval', /\b(sh|bash|zsh)\s+-c\b|\beval\s*[\s(]/],
  ['privilege-escalation', /^\s*(\$\s*)?sudo\s/],
  ['world-writable', /\bchmod\s+-R\s+777\b/],
];

// Scan the text of an instruction or reference file. `where` is the JSON path used in errors.
// legal: verbatim license text; only coupling, secrets and hidden-text checks apply.
export function checkSkillContent(text, where = '$.instructions_path', { legal = false } = {}) {
  const errors = [];
  const add = (code, rule, message) => errors.push({ code, rule, path: where, message });
  if (OPENCLAW.test(text)) add('RUNTIME_COUPLING', 'openclaw', 'skill text must not reference the OpenClaw runtime');
  for (const rule of scanSecrets(text)) add('SECRET_PATTERN', rule, `text looks like a credential (${rule}); content not echoed`);
  if (HIDDEN.test(text)) add('SKILL_CONTENT', 'hidden-text', 'text contains zero-width or bidirectional control characters');
  if (/<!--/.test(text)) add('SKILL_CONTENT', 'hidden-text', 'HTML comments can hide instructions and are not allowed');
  if (EXCLUDED.test(text)) add('RUNTIME_COUPLING', 'excluded-integration', 'skill text must not reference excluded integrations (Context7, Spec Kit)');
  if (legal) return errors;
  const fenced = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (ABS_ANYWHERE.test(line) && !fenced.has('abs')) { fenced.add('abs'); add('ABSOLUTE_PATH', undefined, 'text contains an absolute or machine-specific path'); }
    for (const re of INJECTION) if (re.test(line) && !fenced.has('inj')) { fenced.add('inj'); add('SKILL_CONTENT', 'prompt-injection', 'text contains instruction-override or exfiltration phrasing'); }
    for (const [name, test] of SHELL_RULES) if (test(line) && !fenced.has(name)) { fenced.add(name); add('DANGEROUS_PERMISSION', name, `instruction text contains a dangerous command (${name})`); }
    for (const [name, re] of PIPE_SHELL) if (re.test(line) && !fenced.has(name)) { fenced.add(name); add('DANGEROUS_PERMISSION', name, `instruction text contains a dangerous command (${name})`); }
    if (/\bhttp:\/\/(?!localhost\b|127\.0\.0\.1\b)/i.test(line) && !fenced.has('url')) { fenced.add('url'); add('SKILL_CONTENT', 'insecure-url', 'external references must use https'); }
    if (/\b(javascript|vbscript):|\bdata:[a-z]+\/[a-z]/i.test(line) && !fenced.has('uri')) { fenced.add('uri'); add('SKILL_CONTENT', 'insecure-url', 'script or data URIs are not allowed'); }
  }
  return errors;
}

// Relative markdown links must stay relative; returns link targets for existence checks.
export function relativeLinks(text) {
  return [...text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t));
}
