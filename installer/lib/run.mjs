// Read-only validation driver. Uses only readFileSync/readdirSync/lstatSync.
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, basename, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSupportedSchema, validateSchema } from './schema.mjs';
import { confine } from './confine.mjs';
import { checkAgentPolicy, checkCatalog, checkRuntimeCoupling, checkInstructionsCoupling } from './agents.mjs';
import { checkSkillPolicy, checkSkillCatalog, checkSkillCoupling, checkSkillContent, relativeLinks, isExternal } from './skills.mjs';
import { checkWorkflow, checkAgentMap, checkIntegration, checkProject } from './sdd.mjs';
import { checkMcp, checkMcpSet } from './mcp.mjs';
import { checkDangerous, checkPaths, checkSecrets, checkResult } from './checks.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_DIR = join(REPO_ROOT, 'standards', 'schemas');
export const DEFAULT_MATRIX = join(REPO_ROOT, 'compatibility', 'matrix.json');
export const DEFAULT_INPUTS = [join(REPO_ROOT, 'standards', 'manifests'), join(REPO_ROOT, 'standards', 'sdd'), join(REPO_ROOT, 'compatibility')];

const KIND_SCHEMA = {
  agent: 'agent-manifest.schema.json',
  'agent-catalog': 'agent-catalog.schema.json',
  skill: 'skill-manifest.schema.json',
  'skill-catalog': 'skill-catalog.schema.json',
  mcp: 'mcp-manifest.schema.json',
  'mcp-catalog': 'mcp-catalog.schema.json',
  'mcp-template': 'mcp-template.schema.json',
  adapter: 'adapter-manifest.schema.json',
  'technology-profile': 'technology-profile-manifest.schema.json',
  'compatibility-matrix': 'compatibility-matrix.schema.json',
  'task-contract': 'task-contract.schema.json',
  result: 'result.schema.json',
  'sdd-workflow': 'sdd-workflow.schema.json',
  'sdd-agent-map': 'sdd-agent-map.schema.json',
  'sdd-integration': 'sdd-integration.schema.json',
  'sdd-project': 'sdd-project.schema.json',
};
const SDD_KINDS = new Set(['sdd-workflow', 'sdd-agent-map', 'sdd-integration', 'sdd-project']);
const MANIFEST_KINDS = new Set(['agent', 'skill', 'mcp', 'adapter', 'technology-profile']);
const REFERENCES = {
  agent: [['independent_of', 'agent'], ['skills', 'skill'], ['mcp_servers', 'mcp'], ['technology_profiles', 'technology-profile']],
  skill: [['requires_mcp', 'mcp']],
  adapter: [['supports.agents', 'agent'], ['supports.skills', 'skill'], ['supports.mcp_servers', 'mcp'], ['supports.technology_profiles', 'technology-profile']],
  'technology-profile': [['skills', 'skill'], ['mcp_servers', 'mcp']],
};

export function loadSchemas() {
  const registry = new Map();
  for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.schema.json')).sort()) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8'));
    assertSupportedSchema(schema, f);
    registry.set(f, schema);
  }
  return registry;
}

function collectFiles(input, errors) {
  const files = [];
  const st = lstatSync(input);
  if (st.isSymbolicLink()) { errors.push({ code: 'FILE_STRUCTURE', rule: 'symlink', file: input, path: '$', message: 'symlinks are not followed' }); return files; }
  if (st.isFile()) { files.push(input); return files; }
  for (const name of readdirSync(input).sort()) {
    const p = join(input, name);
    const s = lstatSync(p);
    if (s.isDirectory()) files.push(...collectFiles(p, errors));
    else if (s.isSymbolicLink()) errors.push({ code: 'FILE_STRUCTURE', rule: 'symlink', file: p, path: '$', message: 'symlinks are not followed' });
    else if (name.endsWith('.json')) files.push(p);
    else if (name === '.gitkeep' || name.endsWith('.md')) continue;
    else errors.push({ code: 'FILE_STRUCTURE', rule: 'unexpected-file', file: p, path: '$', message: 'only .json, .md and .gitkeep files are allowed' });
  }
  return files;
}

const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

export function validatePaths(inputs, { matrixPath, root = REPO_ROOT } = {}) {
  const matrixExplicit = matrixPath !== undefined;
  if (!matrixExplicit) matrixPath = DEFAULT_MATRIX;
  const registry = loadSchemas();
  const errors = [];
  const docs = []; // { file, doc }
  const files = [];
  for (const input of inputs) {
    const bad = confine(input, root);
    if (bad) { errors.push({ code: 'FILE_STRUCTURE', rule: bad.rule, file: input, path: '$', message: bad.message }); continue; }
    if (!existsSync(input)) { errors.push({ code: 'FILE_STRUCTURE', rule: 'missing-input', file: input, path: '$', message: 'input does not exist' }); continue; }
    files.push(...collectFiles(input, errors));
  }
  const parse = (file) => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch {
      errors.push({ code: 'INVALID_JSON', file, path: '$', message: 'file is not valid JSON' });
      return undefined;
    }
  };
  for (const file of files) {
    if (!file.endsWith('.json')) { errors.push({ code: 'FILE_STRUCTURE', rule: 'unexpected-file', file, path: '$', message: 'input file must be .json' }); continue; }
    const doc = parse(file);
    if (doc !== undefined) docs.push({ file, doc });
  }

  // per-document checks
  const valid = [];
  const catalogs = [];
  const skillCatalogs = [];
  const sddDocs = [];
  const schemaFailed = new Set();
  for (const { file, doc } of docs) {
    const tag = (list) => list.forEach((e) => errors.push({ ...e, file }));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) { tag([{ code: 'SCHEMA_WRONG_TYPE', path: '$', message: 'document must be an object' }]); continue; }
    if (typeof doc.kind !== 'string') { tag([{ code: 'SCHEMA_MISSING_FIELD', path: '$', message: 'missing required field "kind"' }]); continue; }
    const schemaFile = KIND_SCHEMA[doc.kind];
    if (!schemaFile) { tag([{ code: 'UNKNOWN_KIND', path: '$.kind', message: `unknown kind "${doc.kind}"` }]); continue; }
    const schemaErrors = validateSchema(registry.get(schemaFile), doc, registry);
    tag(schemaErrors);
    if (schemaErrors.length) schemaFailed.add(file);
    tag(checkPaths(doc));
    tag(checkSecrets(doc));
    if (doc.kind !== 'compatibility-matrix') tag(checkDangerous(doc));
    if (['mcp', 'mcp-catalog', 'mcp-template'].includes(doc.kind) && schemaErrors.length === 0) tag(checkMcp(doc));
    if (doc.kind === 'result') tag(checkResult(doc));
    if (['agent', 'agent-catalog', 'skill', 'skill-catalog'].includes(doc.kind)) tag(checkRuntimeCoupling(doc));
    if (doc.kind === 'skill' || doc.kind === 'skill-catalog') tag(checkSkillCoupling(doc));
    if (doc.kind === 'agent-catalog' && schemaErrors.length === 0) catalogs.push({ file, doc });
    if (doc.kind === 'skill-catalog' && schemaErrors.length === 0) skillCatalogs.push({ file, doc });
    if (SDD_KINDS.has(doc.kind) && schemaErrors.length === 0) sddDocs.push({ file, doc });
    if (MANIFEST_KINDS.has(doc.kind) && typeof doc.id === 'string') {
      if (basename(file) !== `${doc.id}.json`) tag([{ code: 'FILE_STRUCTURE', rule: 'filename-mismatch', path: '$.id', message: `file name must be "${doc.id}.json"` }]);
      if (typeof doc.instructions_path === 'string' && !doc.instructions_path.startsWith('/') && !doc.instructions_path.split(/[\\/]/).includes('..')) {
        const target = join(dirname(file), doc.instructions_path);
        let ok = false;
        try { ok = !confine(target, root) && lstatSync(target).isFile(); } catch { ok = false; }
        if (!ok) tag([{ code: 'MISSING_REFERENCE', rule: 'instructions-file', path: '$.instructions_path', message: `instructions file not found: ${doc.instructions_path}` }]);
        else if (doc.kind === 'agent') tag(checkInstructionsCoupling(readFileSync(target, 'utf8')));
        else if (doc.kind === 'skill') tag(checkSkillContent(readFileSync(target, 'utf8'), '$.instructions_path'));
      }
      valid.push({ file, doc });
    }
  }

  errors.push(...checkMcpSet(docs.filter(({ file, doc }) => doc && KIND_SCHEMA[doc.kind] && !schemaFailed.has(file))));

  // duplicates and references across the document set
  const ids = new Map(); // kind -> Map(id -> file)
  for (const { file, doc } of valid) {
    if (!ids.has(doc.kind)) ids.set(doc.kind, new Map());
    const m = ids.get(doc.kind);
    if (m.has(doc.id)) errors.push({ code: 'DUPLICATE_ID', file, path: '$.id', message: `duplicate ${doc.kind} id "${doc.id}" (also in ${relative(REPO_ROOT, m.get(doc.id)).split(sep).join('/')})` });
    else m.set(doc.id, file);
  }
  for (const { file, doc } of valid) {
    for (const [field, kind] of REFERENCES[doc.kind] ?? []) {
      const list = getPath(doc, field);
      if (!Array.isArray(list)) continue;
      for (const ref of list) {
        if (!ids.get(kind)?.has(ref)) errors.push({ code: 'MISSING_REFERENCE', rule: 'component', file, path: `$.${field}`, message: `${kind} "${ref}" is not defined` });
      }
    }
  }

  // agent policy and catalog consistency (only schema-valid documents)
  if (catalogs.length > 1) errors.push({ code: 'DUPLICATE_ID', file: catalogs[1].file, path: '$', message: 'more than one agent catalog supplied' });
  const agentDocs = new Map();
  for (const { file, doc } of valid) if (doc.kind === 'agent' && !schemaFailed.has(file)) agentDocs.set(doc.id, { file, doc });
  const linked = new Set(catalogs[0]?.doc.agents.filter((e) => e.classification !== 'redundant').map((e) => e.id) ?? []);
  for (const [id, { file, doc }] of agentDocs) {
    for (const e of checkAgentPolicy(doc, { strict: linked.has(id) })) errors.push({ ...e, file });
  }
  if (catalogs[0]) {
    for (const e of checkCatalog(catalogs[0].doc, new Map([...agentDocs].map(([id, v]) => [id, v.doc])))) errors.push({ ...e, file: catalogs[0].file });
  }

  checkSkills({ valid, schemaFailed, skillCatalogs, root, errors });
  const primary = catalogs[0] ? new Set(catalogs[0].doc.agents.filter((e) => e.classification === 'primary').map((e) => e.id)) : null;
  checkSdd({ sddDocs, agentDocs, primary, root, errors });

  // declared compatibility
  const matrices = docs.filter(({ doc }) => doc?.kind === 'compatibility-matrix');
  if (matrices.length > 1) errors.push({ code: 'DUPLICATE_ID', file: matrices[1].file, path: '$', message: 'more than one compatibility matrix supplied' });
  let matrix = matrices[0]?.doc;
  const matrixBad = (matrix && !matrixExplicit) ? null : confine(matrixPath, matrixExplicit ? root : REPO_ROOT);
  if (matrixBad) {
    errors.push({ code: 'FILE_STRUCTURE', rule: matrixBad.rule, file: matrixPath, path: '$', message: `matrix rejected: ${matrixBad.message}` });
  } else if (!matrix) {
    if (existsSync(matrixPath)) {
      try { matrix = JSON.parse(readFileSync(matrixPath, 'utf8')); } catch { errors.push({ code: 'INVALID_JSON', file: matrixPath, path: '$', message: 'matrix is not valid JSON' }); }
    } else errors.push({ code: 'FILE_STRUCTURE', rule: 'missing-matrix', file: matrixPath, path: '$', message: 'compatibility matrix not found' });
  }
  if (matrix && validateSchema(registry.get(KIND_SCHEMA['compatibility-matrix']), matrix, registry).length === 0) {
    const unsupported = (file, path, message) => errors.push({ code: 'UNSUPPORTED_COMPATIBILITY', file, path, message });
    for (const { file, doc } of docs) {
      if (!doc || typeof doc !== 'object' || !KIND_SCHEMA[doc.kind] || doc.kind === 'compatibility-matrix') continue;
      if (typeof doc.schema_version === 'string' && !matrix.supported_schema_versions.includes(doc.schema_version)) unsupported(file, '$.schema_version', `schema_version "${doc.schema_version}" is not supported`);
      if (MANIFEST_KINDS.has(doc.kind) && Array.isArray(doc.compatibility?.standard)) {
        for (const v of doc.compatibility.standard) if (typeof v === 'string' && !matrix.supported_standard_versions.includes(v)) unsupported(file, '$.compatibility.standard', `standard version "${v}" is not supported`);
      }
      if (doc.kind === 'adapter' && typeof doc.target_tool === 'string' && !matrix.supported_tools.includes(doc.target_tool)) unsupported(file, '$.target_tool', `target_tool "${doc.target_tool}" is not supported`);
    }
  } else if (matrix) {
    errors.push({ code: 'SCHEMA_CONSTRAINT', file: matrixPath, path: '$', message: 'compatibility matrix does not satisfy its schema' });
  }
  return { errors, filesChecked: files.length };
}

const isSafeRel = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !/^[A-Za-z]:|^[~\\]/.test(p) && !p.split(/[\\/]/).includes('..');
function readIfFile(dir, rel, root) {
  if (!isSafeRel(rel)) return null; // reported as ABSOLUTE_PATH / PATH_TRAVERSAL by checkPaths
  const target = join(dir, rel);
  try { return !confine(target, root) && lstatSync(target).isFile() ? { target, text: readFileSync(target, 'utf8') } : undefined; } catch { return undefined; }
}
function listFiles(dir) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) continue; // rejected earlier by collectFiles
    if (s.isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out;
}

// SDD policy: workflow, agent map, integration and project records. Cross-file
// references (workflow, agent map, agent manifests) must be part of the validated set.
function checkSdd({ sddDocs, agentDocs, primary, root, errors }) {
  const push = (file, list) => list.forEach((e) => errors.push({ file, ...e }));
  const of = (kind) => sddDocs.filter((d) => d.doc.kind === kind);
  const [workflows, maps, integrations, projects] = ['sdd-workflow', 'sdd-agent-map', 'sdd-integration', 'sdd-project'].map(of);
  for (const [name, list] of [['workflow', workflows], ['agent map', maps], ['integration', integrations]]) {
    if (list.length > 1) errors.push({ code: 'DUPLICATE_ID', file: list[1].file, path: '$', message: `more than one SDD ${name} supplied` });
  }
  const workflow = workflows[0];
  const map = maps[0];
  if (workflow) push(workflow.file, checkWorkflow(workflow.doc));
  if (map) push(map.file, checkAgentMap(map.doc, { agentDocs: new Map([...agentDocs].map(([id, v]) => [id, v.doc])), primary }));
  for (const i of integrations) push(i.file, checkIntegration(i.doc, workflow?.doc));
  for (const p of projects) {
    for (const [dep, kind] of [[workflow, 'sdd-workflow'], [map, 'sdd-agent-map']]) {
      if (!dep) errors.push({ code: 'MISSING_REFERENCE', rule: kind, file: p.file, path: '$', message: `SDD project requires an ${kind} document in the validated set` });
    }
    if (workflow && map) push(p.file, checkProject(p.doc, { workflow: workflow.doc, agentMap: map.doc, projectFile: p.file, root }));
  }
}

// Skill policy: strict rules for catalog-linked skills, catalog consistency,
// referenced/notice file content, layout (no stray or quarantined bodies) and
// cross-component rules (no unverified adapter claims, no auto-enabled external skills).
function checkSkills({ valid, schemaFailed, skillCatalogs, root, errors }) {
  const push = (file, list) => list.forEach((e) => errors.push({ file, ...e }));
  if (skillCatalogs.length > 1) errors.push({ code: 'DUPLICATE_ID', file: skillCatalogs[1].file, path: '$', message: 'more than one skill catalog supplied' });
  const catalog = skillCatalogs[0];
  const skills = new Map();
  for (const { file, doc } of valid) if (doc.kind === 'skill' && !schemaFailed.has(file)) skills.set(doc.id, { file, doc });
  const approved = new Set(catalog?.doc.skills.filter((e) => e.classification === 'CORE' || e.classification === 'OPTIONAL').map((e) => e.id) ?? []);

  for (const [id, { file, doc }] of skills) {
    push(file, checkSkillPolicy(doc, { strict: approved.has(id) }));
    const dir = dirname(file);
    const refs = [...(doc.reference_paths ?? []).map((r, i) => [r, `$.reference_paths[${i}]`]), ...(doc.license ? [[doc.license.notice_path, '$.license.notice_path']] : []), ...(doc.license?.license_path ? [[doc.license.license_path, '$.license.license_path']] : [])];
    for (const [rel, path] of refs) {
      const r = readIfFile(dir, rel, root);
      if (r === null) continue;
      if (r === undefined) { push(file, [{ code: 'MISSING_REFERENCE', rule: 'reference-file', path, message: `referenced file not found: ${rel}` }]); continue; }
      if (!rel.endsWith('.md')) push(file, [{ code: 'SKILL_POLICY', rule: 'reference-type', path, message: 'referenced files must be Markdown (.md)' }]);
      push(file, checkSkillContent(r.text, path, { legal: rel.startsWith('licenses/') || path === '$.license.notice_path' || path === '$.license.license_path' }).map((e) => ({ ...e, message: `${rel}: ${e.message}` })));
    }
    // links and backticked repo paths in the instructions must resolve
    const ins = readIfFile(dir, doc.instructions_path, root);
    if (ins) {
      const shipped = new Set([...(doc.reference_paths ?? []), doc.license?.notice_path, doc.license?.license_path]);
      for (const link of relativeLinks(ins.text)) if (!readIfFile(dir, link, root)) push(file, [{ code: 'MISSING_REFERENCE', rule: 'instructions-link', path: '$.instructions_path', message: `instructions link not found: ${link}` }]);
      for (const m of ins.text.matchAll(/`((?:references|licenses)\/[^`\s]+\.md)`/g)) {
        if (!shipped.has(m[1])) push(file, [{ code: 'MISSING_REFERENCE', rule: 'instructions-link', path: '$.instructions_path', message: `instructions mention an unshipped file: ${m[1]}` }]);
      }
    }
  }

  if (catalog) {
    push(catalog.file, checkSkillCatalog(catalog.doc, new Map([...skills].map(([id, v]) => [id, v.doc]))));
    // layout: the catalog directory may only hold the catalog and files of approved skills
    const dir = dirname(catalog.file);
    const allowed = new Set([catalog.file]);
    for (const [id, { file, doc }] of skills) {
      if (!approved.has(id)) continue;
      allowed.add(file);
      for (const rel of [doc.instructions_path, doc.license?.notice_path, doc.license?.license_path, ...(doc.reference_paths ?? [])]) if (isSafeRel(rel)) allowed.add(join(dirname(file), rel));
    }
    for (const f of listFiles(dir)) {
      if (basename(f) === '.gitkeep' || allowed.has(f)) continue;
      errors.push({ code: 'SKILL_POLICY', rule: 'unexpected-skill-file', file: f, path: '$', message: 'file is not part of an approved skill; quarantined, deprecated and unknown skills must not ship instruction text' });
    }
    // cross-component rules
    const entries = new Map(catalog.doc.skills.map((e) => [e.id, e]));
    for (const { file, doc } of valid) {
      const claims = doc.kind === 'adapter' ? doc.supports?.skills : (doc.kind === 'technology-profile' || doc.kind === 'agent') ? doc.skills : undefined;
      for (const id of claims ?? []) {
        if (!entries.has(id)) continue;
        if (doc.kind === 'adapter') push(file, [{ code: 'SKILL_POLICY', rule: 'adapter-claim', path: '$.supports.skills', message: `adapter claims support for skill "${id}" without recorded adapter tests` }]);
        else if (isExternal(skills.get(id)?.doc)) push(file, [{ code: 'SKILL_POLICY', rule: 'auto-enable-external', path: '$.skills', message: `external-service skill "${id}" must not be enabled by default from ${doc.kind} manifests` }]);
      }
    }
  }
}
