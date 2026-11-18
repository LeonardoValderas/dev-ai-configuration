// SDD Artifact Writer: content contracts, canonical serialization and the path policy.
// Pure and provider-neutral. Model-produced content is untrusted DATA: it is parsed, schema- and
// semantics-validated, size-limited and never evaluated or used to choose a path.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../installer/lib/run.mjs';
import { validateSchema } from '../../../installer/lib/schema.mjs';
import { sha256, AdapterError } from '../canonical.mjs';
import { inspect } from '../apply.mjs';
import { checkProject } from '../../../installer/lib/sdd.mjs';

export class WriterError extends AdapterError {
  constructor(code, message, details = {}) { super(code, message); this.details = details; }
}

export const SDD_ROOT = '.sdd';
export const ARTIFACT_NAMES = Object.freeze(['constitution', 'specify', 'project']);
export const MARKDOWN_NAMES = Object.freeze(['constitution', 'specify']); // `project` has no derived Markdown
export const MAX_ARTIFACT_BYTES = 256 * 1024;
export const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SHA_RE = /^[a-f0-9]{64}$/;
export const RECEIPT_NAME_RE = /^(\d{6})-([0-9a-f]{12})\.json$/;
export const NONCE_RE = /^[0-9a-f]{32}$/;

// ---- schemas ----------------------------------------------------------------------------------
const schemaDir = join(REPO_ROOT, 'standards', 'schemas');
const load = (f) => JSON.parse(readFileSync(join(schemaDir, f), 'utf8'));
const REGISTRY = new Map([['common.schema.json', load('common.schema.json')]]);
const SCHEMAS = {
  constitution: load('sdd-constitution.schema.json'),
  specify: load('sdd-specify.schema.json'),
  project: load('sdd-project.schema.json'),
  receipt: load('sdd-write-receipt.schema.json'),
};
export const schemaErrors = (kind, data) => validateSchema(SCHEMAS[kind], data, REGISTRY).map((e) => ({ code: e.code, rule: 'schema', path: e.path, message: e.message }));

// ---- canonical serialization ---------------------------------------------------------------------
export function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalize(v[k])]));
  return v;
}
// JSON is canonical: sorted keys, 2-space indent, UTF-8, LF, trailing newline.
export const canonicalBytes = (v) => Buffer.from(JSON.stringify(canonicalize(v), null, 2) + '\n', 'utf8');
export const digestOf = (v) => sha256(Buffer.from(JSON.stringify(canonicalize(v)), 'utf8'));

// ---- content semantics ---------------------------------------------------------------------------
// Control characters and bidi controls are rejected from every string value.
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
function textErrors(value, path, out) {
  if (typeof value === 'string') {
    if (BAD_TEXT.test(value)) out.push(sem('text-control-characters', path, 'text contains control or bidirectional characters'));
    else if (value.trim() === '') out.push(sem('text-blank', path, 'text must not be blank'));
  } else if (Array.isArray(value)) value.forEach((v, i) => textErrors(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) textErrors(v, `${path}.${k}`, out);
}
const sem = (rule, path, message) => ({ code: 'SDD_ARTIFACT', rule, path, message });
const dupes = (list) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];

// Returns { errors, summary }. Never throws on bad content.
export function validateConstitution(doc, projectId) {
  const errors = schemaErrors('constitution', doc);
  if (errors.length) return { errors, summary: null };
  textErrors(doc, '$', errors);
  if (doc.project_id !== projectId) errors.push(sem('project-mismatch', '$.project_id', 'project_id does not match the requested project'));
  for (const d of dupes([...doc.principles, ...doc.constraints].map((e) => e.id))) errors.push(sem('duplicate-id', '$', `duplicate id "${d}"`));
  return { errors, summary: { principles: doc.principles.length, constraints: doc.constraints.length } };
}

export function validateSpecify(doc, projectId) {
  const errors = schemaErrors('specify', doc);
  if (errors.length) return { errors, summary: null };
  textErrors(doc, '$', errors);
  if (doc.project_id !== projectId) errors.push(sem('project-mismatch', '$.project_id', 'project_id does not match the requested project'));
  for (const d of dupes(doc.requirements.map((r) => r.id))) errors.push(sem('duplicate-id', '$.requirements', `duplicate requirement id "${d}"`));
  for (const d of dupes(doc.acceptance_criteria.map((c) => c.id))) errors.push(sem('duplicate-id', '$.acceptance_criteria', `duplicate acceptance criterion id "${d}"`));
  const reqs = new Map(doc.requirements.map((r) => [r.id, r]));
  const crits = new Map(doc.acceptance_criteria.map((c) => [c.id, c]));
  let links = 0;
  doc.acceptance_criteria.forEach((c, i) => {
    const r = reqs.get(c.requirement);
    if (!r) errors.push(sem('orphan-criterion', `$.acceptance_criteria[${i}].requirement`, `criterion "${c.id}" references undefined requirement "${c.requirement}"`));
    else if (!r.acceptance_criteria.includes(c.id)) errors.push(sem('requirement-backlink', `$.acceptance_criteria[${i}].requirement`, `requirement "${r.id}" does not list criterion "${c.id}"`));
  });
  doc.requirements.forEach((r, i) => {
    if (r.acceptance_criteria.length === 0) errors.push(sem('requirement-without-criterion', `$.requirements[${i}].acceptance_criteria`, `requirement "${r.id}" has no acceptance criterion`));
    for (const cid of r.acceptance_criteria) {
      const c = crits.get(cid);
      if (!c) errors.push(sem('broken-ref', `$.requirements[${i}].acceptance_criteria`, `acceptance criterion "${cid}" is not defined`));
      else if (c.requirement !== r.id) errors.push(sem('criterion-backlink', `$.requirements[${i}].acceptance_criteria`, `criterion "${cid}" belongs to requirement "${c.requirement}"`));
      else links++;
    }
  });
  return { errors, summary: { requirements: doc.requirements.length, acceptance_criteria: doc.acceptance_criteria.length, requirement_to_criterion_links: links } };
}

// The persisted `project` artifact is the canonical SDD Plan/Tasks record (sdd-project.schema.json + checkProject()). It is
// DOCUMENTATION ONLY: it can never claim started work or approvals (persisting it authorizes nothing; `dac implement` has its
// own pre-implementation gate). Its `id` is the SDD project id and is unrelated to the bootstrap package_name record.
let SDD_CTX = null;
const sddCtx = () => (SDD_CTX ??= {
  workflow: JSON.parse(readFileSync(join(REPO_ROOT, 'standards', 'sdd', 'sdd-workflow.json'), 'utf8')),
  agentMap: JSON.parse(readFileSync(join(REPO_ROOT, 'standards', 'sdd', 'sdd-agent-map.json'), 'utf8')),
});
export function validateProject(doc, projectId) {
  const errors = schemaErrors('project', doc);
  if (errors.length) return { errors, summary: null };
  const { validation, ...rest } = doc; // validated_by may legitimately be "" while NOT-RUN
  textErrors(rest, '$', errors);
  textErrors(validation.evidence, '$.validation.evidence', errors);
  if (doc.id !== projectId) errors.push(sem('project-mismatch', '$.id', 'project id does not match the requested project'));
  if (doc.milestone_ref !== undefined) errors.push(sem('milestone-unsupported', '$.milestone_ref', 'milestone_ref is not supported in a persisted project artifact'));
  if (doc.approvals.length) errors.push(sem('documentation-only', '$.approvals', 'a persisted project artifact must not record approvals (documentation never authorizes implementation)'));
  if (doc.files_changed.length) errors.push(sem('documentation-only', '$.files_changed', 'a persisted project artifact must not list changed files'));
  if (doc.validation.validation_result !== 'NOT-RUN' || doc.validation.evidence.length) errors.push(sem('documentation-only', '$.validation', 'a persisted project artifact must be NOT-RUN without evidence'));
  for (const p of ['implement', 'converge', 'independent-validation']) if (doc.completed_phases.includes(p)) errors.push(sem('documentation-only', '$.completed_phases', `phase "${p}" cannot be recorded as completed in a persisted project artifact`));
  doc.tasks.forEach((t, i) => {
    if (t.status !== 'planned') errors.push(sem('documentation-only', `$.tasks[${i}].status`, `task "${t.id}" must be "planned"`));
    (t.validation_commands ?? []).forEach((c, j) => {
      const at = `$.tasks[${i}].validation_commands[${j}]`;
      if (/[\r\n]/.test(c)) errors.push(sem('command-multiline', at, 'a validation command must be a single line'));
    });
  });
  for (const e of checkProject(doc, { ...sddCtx(), projectFile: join(REPO_ROOT, 'project.json'), root: REPO_ROOT })) errors.push({ code: e.code, rule: e.rule, path: e.path, message: e.message });
  return { errors, summary: { tasks: doc.tasks.length, requirements: doc.requirements.length, acceptance_criteria: doc.acceptance_criteria.length } };
}

export const VALIDATORS = { constitution: validateConstitution, specify: validateSpecify, project: validateProject };

// ---- derived Markdown (optional, OFF by default, never authoritative) --------------------------------
const md = (s) => s.replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>#|~!&]/g, '\\$&');
export function renderMarkdown(name, doc) {
  const L = [`# ${name === 'constitution' ? 'Constitution' : 'Specify'}: ${doc.project_id}`, '', '> Derived view generated from the canonical JSON. Not authoritative; hand edits are drift.', ''];
  if (name === 'constitution') {
    L.push('## Principles', '');
    for (const p of doc.principles) L.push(`- **${p.id}**: ${md(p.statement)}${p.rationale ? ` (${md(p.rationale)})` : ''}`);
    L.push('', '## Constraints', '');
    for (const c of doc.constraints) L.push(`- **${c.id}**: ${md(c.statement)}${c.rationale ? ` (${md(c.rationale)})` : ''}`);
  } else {
    L.push('## Requirements', '');
    for (const r of doc.requirements) {
      L.push(`### ${r.id}`, '', md(r.statement), '', `Acceptance criteria: ${r.acceptance_criteria.join(', ')}`);
      for (const q of r.open_questions) L.push(`- Open question: ${md(q)}`);
      L.push('');
    }
    L.push('## Acceptance criteria', '');
    for (const c of doc.acceptance_criteria) L.push(`- **${c.id}** (${c.requirement}): ${md(c.statement)} Verification: ${md(c.verification)}`);
  }
  return Buffer.from(L.join('\n') + '\n', 'utf8');
}

// ---- path policy -------------------------------------------------------------------------------
export const artifactPath = (pid, name, ext) => `${SDD_ROOT}/artifacts/${pid}/${name}.${ext}`;
export const receiptPath = (pid, seq, digest) => `${SDD_ROOT}/receipts/${pid}/${String(seq).padStart(6, '0')}-${digest.slice(0, 12)}.json`;
export const consumedPath = (pid, nonce) => `${SDD_ROOT}/consumed/${pid}/${nonce}.json`;
export const lockPath = (pid) => `${SDD_ROOT}/locks/${pid}.lock`;
export const artifactPaths = (pid) => ARTIFACT_NAMES.flatMap((n) => (MARKDOWN_NAMES.includes(n) ? [artifactPath(pid, n, 'json'), artifactPath(pid, n, 'md')] : [artifactPath(pid, n, 'json')]));

const FORBIDDEN_ROOTS = ['.dac', '.git', '.specify', 'specs', '.github'];
const CODE_EXT = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|py|rb|pl|php|ps1|bat|cmd|exe|dll|so|dylib|yml|yaml|toml|ini|env|sql)$/i;

// Throws WriterError PATH_POLICY unless `rel` is exactly one of the paths the writer may create for the project.
export function assertAllowedPath(rel, projectId) {
  const deny = (why) => { throw new WriterError('PATH_POLICY', `path rejected: ${why}`, { path: typeof rel === 'string' ? rel.slice(0, 200) : typeof rel }); };
  if (!ID_RE.test(projectId ?? '') || projectId.length > 64) deny('invalid project id');
  if (typeof rel !== 'string' || rel === '') deny('empty or non-string path');
  if (/[\u0000-\u001f\u007f]/.test(rel)) deny('control characters');
  if (rel.includes('\\')) deny('backslash');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.startsWith('~')) deny('absolute path');
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) deny('empty, "." or ".." segment');
  if (/[^ -~]/.test(rel)) deny('non-ASCII path (Unicode alias risk)');
  if (FORBIDDEN_ROOTS.includes(segs[0].toLowerCase())) deny('reserved or externally owned location');
  if (CODE_EXT.test(rel) || /(^|\/)package(-lock)?\.json$/i.test(rel)) deny('code, script or configuration destination');
  if (segs[0] !== SDD_ROOT) deny('outside .sdd/');
  const ok = artifactPaths(projectId).includes(rel)
    || new RegExp(`^\\.sdd/receipts/${projectId}/\\d{6}-[0-9a-f]{12}\\.json$`).test(rel)
    || new RegExp(`^\\.sdd/consumed/${projectId}/[0-9a-f]{32}\\.json$`).test(rel)
    || rel === lockPath(projectId);
  if (!ok) deny('not on the exact allowlist (case or Unicode aliases are not accepted)');
  return rel;
}

const fold = (s) => s.normalize('NFKC').toLowerCase();

// Rejects a destination whose parent already holds a different entry with the same case/Unicode-folded name.
export function assertNoAliases(root, rel) {
  const segs = rel.split('/');
  let dir = root;
  for (const seg of segs) {
    let names;
    try { names = readdirSync(dir); } catch { return; } // missing directory: nothing to alias
    const clash = names.find((n) => n !== seg && fold(n) === fold(seg));
    if (clash) throw new WriterError('PATH_POLICY', 'path rejected: an existing entry is a case or Unicode alias of the destination', { path: rel });
    dir = join(dir, seg);
    try { if (!lstatSync(dir).isDirectory()) return; } catch { return; }
  }
}

// Reads one destination safely. Returns { kind: 'missing' } | { kind: 'file', buf, sha256 }; throws on anything unusable.
export function readDestination(root, rel) {
  assertNoAliases(root, rel);
  const cur = inspect(root, rel);
  if (cur.kind === 'missing') return { kind: 'missing' };
  if (cur.kind !== 'file') throw new WriterError('PATH_POLICY', `path rejected: ${cur.reason}`, { path: rel });
  if (lstatSync(join(root, ...rel.split('/'))).nlink > 1) throw new WriterError('PATH_POLICY', 'path rejected: hard-linked file', { path: rel });
  return { kind: 'file', buf: cur.buf, sha256: sha256(cur.buf) };
}

export const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);
