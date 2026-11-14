#!/usr/bin/env node
// codex adapter CLI. Exit codes: 0 ok, 1 conflict/failure, 2 usage error.
// Never touches user-level configuration; writes only inside --target.
import { resolve } from 'node:path';
import { generate, AdapterError } from './lib/generate.mjs';
import { apply, uninstall } from './lib/apply.mjs';

const USAGE = `Usage: node adapters/codex/cli.mjs <command> [options]
Commands:
  plan                     List generated files (no writes)
  apply --target <dir>     Install into an existing project directory (--dry-run supported)
  uninstall --target <dir> Remove unmodified adapter-managed files (--dry-run supported)
Options:
  --include-context7-template        Include an inert Context7 template (never connects)
  --dry-run                Report actions without writing
  --json                   Machine-readable output`;

const args = process.argv.slice(2);
const cmd = args.shift();
const opts = { context7: false, dryRun: false, json: false, target: undefined };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--include-context7-template') opts.context7 = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--target' && args[i + 1]) opts.target = resolve(args[++i]);
  else { console.error(`Unknown or incomplete option: ${a}\n${USAGE}`); process.exit(2); }
}
if (!['plan', 'apply', 'uninstall'].includes(cmd)) { console.error(USAGE); process.exit(cmd === '--help' || cmd === '-h' ? 0 : 2); }
if (cmd !== 'plan' && !opts.target) { console.error(`--target is required\n${USAGE}`); process.exit(2); }

const out = (o, text) => console.log(opts.json ? JSON.stringify(o, null, 2) : text);
try {
  if (cmd === 'plan') {
    const plan = generate({ context7: opts.context7 });
    const files = [...plan.files.keys()];
    out({ files }, files.join('\n'));
  } else if (cmd === 'apply') {
    const r = apply(opts.target, generate({ context7: opts.context7 }), { dryRun: opts.dryRun });
    out(r, `${r.status}: created ${r.created.length}, updated ${r.updated.length}, removed ${r.removed.length}, unchanged ${r.unchanged.length}${r.conflicts.map((c) => `\nCONFLICT ${c.path}: ${c.reason}`).join('')}`);
    process.exit(r.status === 'CONFLICT' ? 1 : 0);
  } else {
    const r = uninstall(opts.target, { dryRun: opts.dryRun });
    out(r, `${r.status}: removed ${r.removed.length}, kept ${r.kept.length}${r.conflicts.map((c) => `\nCONFLICT ${c.path}: ${c.reason}`).join('')}`);
    process.exit(r.status === 'CONFLICT' ? 1 : 0);
  }
} catch (e) {
  if (e instanceof AdapterError) { console.error(`${e.code}: ${e.message}`); process.exit(1); }
  console.error(`adapter failure: ${e.message}`);
  process.exit(1);
}
