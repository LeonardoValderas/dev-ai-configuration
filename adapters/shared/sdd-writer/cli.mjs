#!/usr/bin/env node
// SDD Artifact Writer CLI (provider-neutral): plan | apply | verify.
// There is deliberately no approval flag: approval happens only on the controlling terminal opened by the
// writer. Exit codes: 0 ok, 1 refused/failed/drift, 2 usage error.
import { lstatSync, openSync, readSync, closeSync, realpathSync, fstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { plan, apply, verify, WriterError } from './writer.mjs';

const MAX_INPUT = 512 * 1024;
const USAGE = `Usage: node adapters/shared/sdd-writer/cli.mjs <command> [options]
Commands:
  plan   --target <dir> --input <file>        Validate and print the canonical plan (no writes)
  apply  --target <dir> --input <file>        Write after approval on the controlling terminal
         [--recover-lock]                     Offer recovery of a stale lock (terminal confirmation required)
  verify --target <dir> --project <id>        Re-read disk and check artifacts against receipts (no writes)
Options:
  --json                                      Machine-readable output
Approval cannot be supplied by flags, environment variables, stdin, files or model output.`;

const REFUSED = new Set(['--yes', '-y', '--force', '--approve', '--approved', '--authorization', '--auth', '--no-interactive', '--non-interactive', '--confirm']);

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, json: false, recover: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (REFUSED.has(a)) return { usage: `${a} is not supported: approval is only possible interactively on the controlling terminal` };
    if (a === '--json') o.json = true;
    else if (a === '--recover-lock') o.recover = true;
    else if (a === '--target' && rest[i + 1]) o.target = resolve(rest[++i]);
    else if (a === '--input' && rest[i + 1]) o.input = rest[++i];
    else if (a === '--project' && rest[i + 1]) o.project = rest[++i];
    else return { usage: `Unknown or incomplete option: ${a}` };
  }
  if (!['plan', 'apply', 'verify'].includes(cmd)) return { usage: cmd === '--help' || cmd === '-h' ? '' : 'Unknown command', help: cmd === '--help' || cmd === '-h' };
  if (!o.target) return { usage: '--target is required' };
  if (cmd !== 'verify' && (!o.input || o.input === '-')) return { usage: '--input <file> is required (stdin is not accepted)' };
  if (cmd === 'verify' && !o.project) return { usage: '--project is required' };
  if (cmd !== 'apply' && o.recover) return { usage: '--recover-lock is only valid for apply' };
  if (cmd === 'verify' && o.input) return { usage: 'verify does not take --input' };
  return o;
}

function readInput(file) {
  const p = resolve(file);
  const st = lstatSync(p);
  if (!st.isFile()) throw new WriterError('INPUT', 'input must be a regular file');
  const fd = openSync(p, 'r');
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_INPUT) throw new WriterError('INPUT', 'input is too large or not a regular file');
    const buf = Buffer.alloc(fstatSync(fd).size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new WriterError('INPUT', 'input is not valid JSON'); }
  } finally { closeSync(fd); }
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.usage !== undefined) { console.error((o.usage ? o.usage + '\n' : '') + USAGE); return o.help ? 0 : 2; }
  const emit = (obj, text) => console.log(o.json ? JSON.stringify(obj, null, 2) : text);
  try {
    if (o.cmd === 'verify') {
      const r = verify({ target: o.target, projectId: o.project });
      emit(r, `${r.status}${r.findings.map((f) => `\n${f.kind.toUpperCase()} ${f.path}: ${f.reason}`).join('')}`);
      return r.status === 'OK' ? 0 : 1;
    }
    const input = readInput(o.input);
    const r = o.cmd === 'plan' ? plan({ target: o.target, input }) : apply({ target: o.target, input, recoverLock: o.recover });
    emit(r, `${r.status}: plan digest ${r.plan_digest}${r.files_changed?.length ? `\n${r.files_changed.join('\n')}` : ''}`);
    return 0;
  } catch (e) {
    const known = e instanceof WriterError || typeof e?.code === 'string';
    const d = e.details ?? {};
    const out = { status: 'FAILED', code: known ? e.code : 'FAILURE', message: known ? e.message : 'writer failure', files_changed: d.files_changed ?? [], rollback: d.rollback ?? { status: 'not-needed', failed_paths: [] }, ...(d.errors ? { errors: d.errors } : {}), ...(d.evidence ? { evidence: d.evidence } : {}) };
    if (o.json) console.log(JSON.stringify(out, null, 2));
    else console.error(`${out.code}: ${out.message}${(out.errors ?? []).map((x) => `\n  ${x.path}: ${x.message}`).join('')}${out.rollback.status === 'failed' ? `\nROLLBACK FAILED for: ${out.rollback.failed_paths.join(', ')}` : ''}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
