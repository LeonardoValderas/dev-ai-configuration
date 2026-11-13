#!/usr/bin/env node
// Read-only validator CLI. Exit codes: 0 valid, 1 invalid, 2 usage error.
import { resolve, relative, sep } from 'node:path';
import { validatePaths, DEFAULT_INPUTS, REPO_ROOT } from './lib/run.mjs';

const USAGE = `Usage: node installer/validate.mjs [--json] [--matrix <file>] [path ...]
Validates manifests, task contracts and results (files or directories).
Default paths: standards/manifests and compatibility. Never modifies files.
All paths and --matrix must lie inside this repository (the fixed authorized
root). Symlinks are rejected, never followed.`;

const args = process.argv.slice(2);
let json = false;
let matrixPath;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  else if (a === '--json') json = true;
  else if (a === '--matrix') { if (!args[i + 1]) { console.error(USAGE); process.exit(2); } matrixPath = resolve(args[++i]); }
  else if (a.startsWith('-')) { console.error(`Unknown option: ${a}\n${USAGE}`); process.exit(2); }
  else inputs.push(resolve(a));
}

let result;
try {
  result = validatePaths(inputs.length ? inputs : DEFAULT_INPUTS, { matrixPath, root: REPO_ROOT });
} catch (e) {
  console.error(`validator failure: ${e.message}`);
  process.exit(2);
}
const rel = (f) => (f ? relative(process.cwd(), f).split(sep).join('/') || '.' : '');
const { errors, filesChecked } = result;
if (json) {
  console.log(JSON.stringify({ ok: errors.length === 0, filesChecked, errors: errors.map((e) => ({ ...e, file: rel(e.file) })) }, null, 2));
} else {
  for (const e of errors) console.log(`ERROR ${e.code}${e.rule ? `[${e.rule}]` : ''} ${rel(e.file)} ${e.path}: ${e.message}`);
  console.log(errors.length ? `FAIL: ${errors.length} error(s) in ${filesChecked} file(s)` : `PASS: ${filesChecked} file(s) validated`);
}
process.exit(errors.length ? 1 : 0);
