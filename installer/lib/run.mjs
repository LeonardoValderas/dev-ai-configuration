// Read-only validation driver. Uses only readFileSync/readdirSync/lstatSync.
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, basename, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSupportedSchema, validateSchema } from './schema.mjs';
import { confine } from './confine.mjs';
import { checkAgentPolicy, checkCatalog, checkRuntimeCoupling, checkInstructionsCoupling } from './agents.mjs';
import { checkDangerous, checkPaths, checkSecrets, checkResult } from './checks.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_DIR = join(REPO_ROOT, 'standards', 'schemas');
export const DEFAULT_MATRIX = join(REPO_ROOT, 'compatibility', 'matrix.json');
export const DEFAULT_INPUTS = [join(REPO_ROOT, 'standards', 'manifests'), join(REPO_ROOT, 'compatibility')];

const KIND_SCHEMA = {
  agent: 'agent-manifest.schema.json',
  'agent-catalog': 'agent-catalog.schema.json',
  skill: 'skill-manifest.schema.json',
  mcp: 'mcp-manifest.schema.json',
  adapter: 'adapter-manifest.schema.json',
  'technology-profile': 'technology-profile-manifest.schema.json',
  'compatibility-matrix': 'compatibility-matrix.schema.json',
  'task-contract': 'task-contract.schema.json',
  result: 'result.schema.json',
};
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
    if (doc.kind === 'result') tag(checkResult(doc));
    if (doc.kind === 'agent' || doc.kind === 'agent-catalog') tag(checkRuntimeCoupling(doc));
    if (doc.kind === 'agent-catalog' && schemaErrors.length === 0) catalogs.push({ file, doc });
    if (MANIFEST_KINDS.has(doc.kind) && typeof doc.id === 'string') {
      if (basename(file) !== `${doc.id}.json`) tag([{ code: 'FILE_STRUCTURE', rule: 'filename-mismatch', path: '$.id', message: `file name must be "${doc.id}.json"` }]);
      if (typeof doc.instructions_path === 'string' && !doc.instructions_path.startsWith('/') && !doc.instructions_path.split(/[\\/]/).includes('..')) {
        const target = join(dirname(file), doc.instructions_path);
        let ok = false;
        try { ok = !confine(target, root) && lstatSync(target).isFile(); } catch { ok = false; }
        if (!ok) tag([{ code: 'MISSING_REFERENCE', rule: 'instructions-file', path: '$.instructions_path', message: `instructions file not found: ${doc.instructions_path}` }]);
        else if (doc.kind === 'agent') tag(checkInstructionsCoupling(readFileSync(target, 'utf8')));
      }
      valid.push({ file, doc });
    }
  }

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
