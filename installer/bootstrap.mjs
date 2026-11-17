#!/usr/bin/env node
// Project bootstrap facade: plan | apply | verify | update | uninstall for Claude Code, Codex and Cursor.
// One engine: provider generators + createInstaller planners (adapters/*/lib/apply.mjs) and the shared
// journaled executor (adapters/shared/apply.mjs). Everything is planned conflict-free before the first
// write and executed in a single journal across all providers, the shared AGENTS.md ledger and .dac/*.
// The standard must come from a clean Git checkout with a full verifiable HEAD (adapters/shared/source.mjs).
// Exit codes: 0 ok, 1 conflict/failure/drift, 2 usage error.
import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { REPO_ROOT } from './lib/run.mjs';
import { verifySource } from '../adapters/shared/source.mjs';
import { executeActions, inspect, resolveTarget } from '../adapters/shared/apply.mjs';
import { AdapterError, sha256, selectAgents } from '../adapters/shared/canonical.mjs';
import { generatePortable, neutralAgentsMd, SHARED_AGENTS_PATH } from '../adapters/shared/portable.mjs';
import * as claude from '../adapters/claude-code/lib/apply.mjs';
import { generate as generateClaude } from '../adapters/claude-code/lib/generate.mjs';
import * as codex from '../adapters/codex/lib/apply.mjs';
import * as cursor from '../adapters/cursor/lib/apply.mjs';

export const PROVIDERS = ['claude-code', 'codex', 'cursor'];
const SHARED_PROVIDERS = ['codex', 'cursor']; // owners of the neutral AGENTS.md
const HANDOFF_PROVIDERS = ['claude-code', 'codex']; // providers that can own the SDD handoff runtime (never cursor)
export const STANDARD_PATH = '.dac/standard.json';
export const SHARED_PATH = '.dac/shared.json';
export const PROJECT_PATH = '.dac/project.json'; // optional managed record: { schema, package_name } (never an SDD project_id)
// package_name is ecosystem-neutral metadata (npm, PyPI, Cargo, Go modules, Maven/Gradle, ...), never a filesystem path.
// Contract: 1..214 chars; no control/format/unassigned characters or backslashes; no leading/trailing whitespace; no leading '-';
// '/'-separated segments must be non-empty and never '.' or '..'; no absolute path ('/x', 'C:/x', 'C:\\x').
export const PACKAGE_NAME_RULE = 'a non-empty name of at most 214 characters without control characters, backslashes, leading/trailing whitespace, a leading "-", an absolute path or "."/".." path segments';
export const validPackageName = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 214 && n === n.trim() && !/[\p{C}\\]/u.test(n) && !n.startsWith('-')
  && !/^[A-Za-z]:\//.test(n) && n.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
const INSTALLERS = { 'claude-code': claude, codex, cursor };
const MANIFEST_PATHS = { 'claude-code': '.claude/dac-manifest.json', codex: '.codex/dac-manifest.json', cursor: '.cursor/dac-manifest.json' };
const json = (o) => Buffer.from(JSON.stringify(o, null, 2) + '\n');
const sortStr = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isHash = (h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);

// ---- records ---------------------------------------------------------------
const exactKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && same(sortStr(Object.keys(o)), sortStr(keys));

function readRecord(root, path, parse) {
  const cur = inspect(root, path);
  if (cur.kind === 'missing') return { missing: true };
  if (cur.kind !== 'file') return { error: `${path} unusable (${cur.reason})` };
  try {
    const value = JSON.parse(cur.buf.toString('utf8'));
    const canonical = parse(value);
    if (!json(canonical).equals(cur.buf)) return { error: `${path} is not in canonical form (modified)` };
    return { value: canonical, buf: cur.buf };
  } catch (e) { return { error: e instanceof AdapterError ? e.message : `${path} is not a valid record` }; }
}
const bad = (m) => { throw new AdapterError('RECORD', m); };

function parseStandard(v) {
  if (!exactKeys(v, ['schema', 'standard_version', 'standard_commit', 'providers']) || v.schema !== 1) bad('standard record has unexpected shape');
  if (!/^[0-9a-f]{40}$/.test(v.standard_commit) || typeof v.standard_version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(v.standard_version)) bad('standard record has invalid version or commit');
  if (!v.providers || typeof v.providers !== 'object' || Array.isArray(v.providers) || !Object.keys(v.providers).length) bad('standard record lists no providers');
  const providers = {};
  for (const p of sortStr(Object.keys(v.providers))) {
    const r = v.providers[p];
    const withHandoff = HANDOFF_PROVIDERS.includes(p) && r && r.sdd_handoff !== undefined; // optional, claude-code/codex only, only ever `true`
    if (!PROVIDERS.includes(p) || !exactKeys(r, withHandoff ? ['adapter_version', 'context7', 'optional_agents', 'sdd_handoff'] : ['adapter_version', 'context7', 'optional_agents']) || typeof r.adapter_version !== 'string' || typeof r.context7 !== 'boolean' || !Array.isArray(r.optional_agents) || r.optional_agents.some((a) => typeof a !== 'string') || (withHandoff && r.sdd_handoff !== true)) bad('standard record has invalid provider entry');
    providers[p] = { adapter_version: r.adapter_version, context7: r.context7, optional_agents: sortStr(r.optional_agents), ...(withHandoff ? { sdd_handoff: true } : {}) };
  }
  return { schema: 1, standard_version: v.standard_version, standard_commit: v.standard_commit, providers };
}

function parseProject(v) {
  if (!exactKeys(v, ['schema', 'package_name']) || v.schema !== 1 || !validPackageName(v.package_name)) bad('project record has unexpected shape or invalid package_name');
  return { schema: 1, package_name: v.package_name };
}

function parseLedger(v) {
  if (!exactKeys(v, ['schema', 'files']) || v.schema !== 1 || !Array.isArray(v.files) || !v.files.length) bad('shared ledger has unexpected shape');
  const seen = new Set();
  const files = v.files.map((f) => {
    if (!exactKeys(f, ['path', 'sha256', 'owners']) || f.path !== SHARED_AGENTS_PATH || seen.has(f.path) || !isHash(f.sha256) || !Array.isArray(f.owners) || !f.owners.length || f.owners.some((o) => !SHARED_PROVIDERS.includes(o)) || new Set(f.owners).size !== f.owners.length) bad('shared ledger has an invalid or unknown entry');
    seen.add(f.path);
    return { path: f.path, sha256: f.sha256, owners: sortStr(f.owners) };
  });
  return { schema: 1, files };
}

// ---- state -----------------------------------------------------------------
function optionsFromManifest(p, m) {
  if (p === 'claude-code') {
    const defaults = selectAgents(JSON.parse(readFileSync(resolve(REPO_ROOT, 'standards/manifests/agents/agent-catalog.json'), 'utf8')));
    return { context7: m.context7_enabled === true, optionalAgents: sortStr(m.agents.filter((a) => !defaults.includes(a))), sddHandoff: m.sdd_handoff === true };
  }
  return { context7: m.context7_template === true, optionalAgents: [], sddHandoff: p === 'codex' && m.sdd_handoff === true };
}

function readState(root) {
  const conflicts = [];
  const providers = new Map(); // installed providers
  for (const p of PROVIDERS) {
    const r = INSTALLERS[p].readManifest(root);
    if (r.error) { conflicts.push({ path: MANIFEST_PATHS[p], reason: r.error }); providers.set(p, { broken: true }); continue; }
    if (!r.manifest) continue;
    const m = r.manifest;
    let legacy = false;
    if (SHARED_PROVIDERS.includes(p)) {
      const listsAgents = m.files.some((f) => f.path === SHARED_AGENTS_PATH);
      if (m.shared_paths === undefined) legacy = true;
      else if (!same(m.shared_paths, [SHARED_AGENTS_PATH]) || listsAgents) { conflicts.push({ path: MANIFEST_PATHS[p], reason: 'manifest has an unexpected shared path declaration' }); providers.set(p, { broken: true }); continue; }
    }
    providers.set(p, { manifest: m, buf: r.buf, legacy, options: optionsFromManifest(p, m) });
  }
  const standard = readRecord(root, STANDARD_PATH, parseStandard);
  const ledger = readRecord(root, SHARED_PATH, parseLedger);
  const project = readRecord(root, PROJECT_PATH, parseProject);
  if (project.error) conflicts.push({ path: PROJECT_PATH, reason: project.error });
  if (project.value && !providers.size) conflicts.push({ path: PROJECT_PATH, reason: 'project record exists without an installed provider' });
  if (standard.error) conflicts.push({ path: STANDARD_PATH, reason: standard.error });
  if (ledger.error) conflicts.push({ path: SHARED_PATH, reason: ledger.error });
  const installed = sortStr([...providers.keys()]);
  if (standard.value && !same(sortStr(Object.keys(standard.value.providers)), installed)) conflicts.push({ path: STANDARD_PATH, reason: 'recorded providers disagree with provider manifests' });
  if (!standard.value && !standard.error && !standard.missing) conflicts.push({ path: STANDARD_PATH, reason: 'standard record unusable' });
  if (standard.missing && ledger.value) conflicts.push({ path: SHARED_PATH, reason: 'shared ledger exists without a standard record' });
  if (standard.missing && [...providers.values()].some((s) => s.manifest && s.manifest.shared_paths !== undefined)) conflicts.push({ path: STANDARD_PATH, reason: 'standard record is missing for a bootstrapped provider' });
  // shared owners must agree with the neutral manifests
  const derived = sortStr(installed.filter((p) => providers.get(p).manifest && providers.get(p).manifest.shared_paths !== undefined));
  const entry = ledger.value?.files.find((f) => f.path === SHARED_AGENTS_PATH);
  if (!ledger.error && !installed.some((p) => providers.get(p).broken)) {
    if (derived.length && !entry) conflicts.push({ path: SHARED_PATH, reason: 'shared ledger does not track AGENTS.md for installed providers' });
    else if (entry && !same(entry.owners, derived)) conflicts.push({ path: SHARED_PATH, reason: 'shared ledger owners disagree with provider manifests' });
    else if (!derived.length && entry) conflicts.push({ path: SHARED_PATH, reason: 'shared ledger tracks AGENTS.md without an owning provider' });
  }
  return { providers, installed, standard, ledger, project, entry, conflicts };
}

// ---- planning --------------------------------------------------------------
const act = (op, path, buf, previous) => ({ op, path, ...(buf ? { buf } : {}), ...(previous ? { previous } : {}) });

function genProvider(p, o) {
  if (p === 'claude-code') return generateClaude({ context7: o.context7, optionalAgents: o.optionalAgents, sddHandoff: o.sddHandoff === true });
  if (o.optionalAgents.length) throw new AdapterError('OPTIONS', 'optional agents are only supported for claude-code');
  return generatePortable(p, { context7: o.context7, neutralAgents: true, ...(p === 'codex' ? { sddHandoff: o.sddHandoff === true } : {}) });
}

// A record file (standard.json / shared.json) is owned entirely by the bootstrap and rewritten canonically.
function planRecord(root, path, desired, existing) {
  const cur = inspect(root, path);
  if (cur.kind === 'other') return { conflict: { path, reason: cur.reason } };
  if (!desired) return cur.kind === 'file' ? { action: act('remove', path, null, cur.buf) } : {};
  if (cur.kind === 'missing') return { action: act('create', path, desired) };
  if (cur.buf.equals(desired)) return { action: { op: 'unchanged', path } };
  if (!existing?.value) return { conflict: { path, reason: 'record exists and is not valid' } };
  return { action: act('update', path, desired, cur.buf) };
}

function planSharedAgents(root, state, finalSet, claimed) {
  const owners = finalSet.filter((p) => SHARED_PROVIDERS.includes(p));
  const conflicts = [];
  const actions = [];
  let ledgerBuf = null;
  if (owners.length) {
    const buf = neutralAgentsMd();
    const nh = sha256(buf);
    ledgerBuf = json({ schema: 1, files: [{ path: SHARED_AGENTS_PATH, sha256: nh, owners }] });
    if (claimed.has(SHARED_AGENTS_PATH)) conflicts.push({ path: SHARED_AGENTS_PATH, reason: 'path is also claimed by a provider file set' });
    const cur = inspect(root, SHARED_AGENTS_PATH);
    if (cur.kind === 'other') conflicts.push({ path: SHARED_AGENTS_PATH, reason: cur.reason });
    else if (cur.kind === 'missing') actions.push(act('create', SHARED_AGENTS_PATH, buf));
    else {
      const disk = sha256(cur.buf);
      if (disk === nh) actions.push({ op: 'unchanged', path: SHARED_AGENTS_PATH });
      else if (state.entry) {
        if (state.entry.sha256 === disk) actions.push(act('update', SHARED_AGENTS_PATH, buf, cur.buf));
        else conflicts.push({ path: SHARED_AGENTS_PATH, reason: 'shared file was modified locally' });
      } else {
        // Legacy migration: only a provider-specific AGENTS.md that is still byte-identical to what this
        // standard's legacy generator produces, and unmodified against the legacy manifest, may be adopted.
        const legacyOwner = finalSet.filter((p) => state.providers.get(p)?.legacy).find((p) => state.providers.get(p).manifest.files.some((f) => f.path === SHARED_AGENTS_PATH && f.sha256 === disk));
        if (legacyOwner && sha256(generatePortable(legacyOwner).files.get(SHARED_AGENTS_PATH)) === disk) actions.push(act('update', SHARED_AGENTS_PATH, buf, cur.buf));
        else conflicts.push({ path: SHARED_AGENTS_PATH, reason: legacyOwner ? 'legacy AGENTS.md is not canonical for this standard; cannot migrate' : 'file exists and is not managed by the bootstrap' });
      }
    }
  }
  return { actions, conflicts, ledgerBuf };
}

function compose(root, state, src, finalSet, optionsFor, { requireSameCommit, packageName }) {
  const conflicts = [...state.conflicts];
  const actions = [];
  const claimed = new Set();
  if (requireSameCommit && state.standard.value && state.standard.value.standard_commit !== src.head) conflicts.push({ path: STANDARD_PATH, reason: 'installed from a different standard commit; run update' });
  const providerRecords = {};
  {
    for (const p of finalSet) {
      const st = state.providers.get(p);
      if (st?.broken) continue;
      const plan = genProvider(p, optionsFor(p));
      const r = INSTALLERS[p].planActions(root, plan);
      let acts = r.actions;
      if (st?.legacy) acts = acts.filter((a) => !(a.op === 'remove' && a.path === SHARED_AGENTS_PATH)); // migrated by the shared planner
      for (const a of acts) {
        if (claimed.has(a.path)) conflicts.push({ path: a.path, reason: 'path claimed by more than one provider' });
        claimed.add(a.path);
      }
      actions.push(...acts);
      conflicts.push(...r.conflicts);
      providerRecords[p] = { adapter_version: plan.manifest.adapter_version, context7: optionsFor(p).context7, optional_agents: sortStr(optionsFor(p).optionalAgents), ...(HANDOFF_PROVIDERS.includes(p) && optionsFor(p).sddHandoff ? { sdd_handoff: true } : {}) };
    }
  }
  const shared = planSharedAgents(root, state, finalSet, claimed);
  actions.push(...shared.actions);
  conflicts.push(...shared.conflicts);
  const desiredStandard = finalSet.length ? json({ schema: 1, standard_version: src.version, standard_commit: src.head, providers: Object.fromEntries(sortStr(finalSet).map((p) => [p, providerRecords[p]])) }) : null;
  // package_name: undefined keeps the current record (or none); a string sets it. The record is bootstrap-owned and canonical.
  const desiredProject = packageName !== undefined ? json({ schema: 1, package_name: packageName }) : (state.project.value ? state.project.buf : null);
  const records = [[SHARED_PATH, shared.ledgerBuf, state.ledger], ...(state.project.error ? [] : [[PROJECT_PATH, desiredProject, state.project]]), [STANDARD_PATH, desiredStandard, state.standard]];
  for (const [path, desired, existing] of records) {
    const r = planRecord(root, path, desired, existing);
    if (r.conflict) conflicts.push(r.conflict);
    else if (r.action) actions.push(r.action);
  }
  return { actions, conflicts };
}

function planUninstall(root, state, provider, src) {
  const conflicts = [...state.conflicts];
  const actions = [];
  const st = state.providers.get(provider);
  if (!st || st.broken) return { actions, conflicts };
  const remaining = state.installed.filter((p) => p !== provider);
  const toRemove = [...st.manifest.files, { path: MANIFEST_PATHS[provider], sha256: sha256(st.buf) }];
  for (const f of toRemove) {
    const cur = inspect(root, f.path);
    if (cur.kind === 'missing') continue;
    if (cur.kind !== 'file') { conflicts.push({ path: f.path, reason: cur.reason }); continue; }
    if (sha256(cur.buf) !== f.sha256) { conflicts.push({ path: f.path, reason: 'managed file was modified locally' }); continue; }
    actions.push(act('remove', f.path, null, cur.buf));
  }
  const owners = remaining.filter((p) => SHARED_PROVIDERS.includes(p) && state.providers.get(p).manifest.shared_paths !== undefined);
  let ledgerBuf = null;
  if (state.entry && state.entry.owners.includes(provider)) {
    if (owners.length) ledgerBuf = json({ schema: 1, files: [{ path: SHARED_AGENTS_PATH, sha256: state.entry.sha256, owners }] });
    else {
      const cur = inspect(root, SHARED_AGENTS_PATH);
      if (cur.kind === 'other') conflicts.push({ path: SHARED_AGENTS_PATH, reason: cur.reason });
      else if (cur.kind === 'file') {
        if (sha256(cur.buf) === state.entry.sha256) actions.push(act('remove', SHARED_AGENTS_PATH, null, cur.buf));
        else conflicts.push({ path: SHARED_AGENTS_PATH, reason: 'shared file was modified locally' });
      }
    }
  } else if (state.ledger.value) ledgerBuf = state.ledger.buf;
  if (state.ledger.value) {
    const r = planRecord(root, SHARED_PATH, ledgerBuf, state.ledger);
    if (r.conflict) conflicts.push(r.conflict); else if (r.action && r.action.op !== 'unchanged') actions.push(r.action);
  }
  if (state.standard.value) {
    const rec = state.standard.value;
    const providers = { ...rec.providers };
    delete providers[provider];
    const desired = remaining.length ? json({ ...rec, providers }) : null;
    const r = planRecord(root, STANDARD_PATH, desired, state.standard);
    if (r.conflict) conflicts.push(r.conflict); else if (r.action && r.action.op !== 'unchanged') actions.push(r.action);
  }
  if (state.project.value && !remaining.length) {
    const r = planRecord(root, PROJECT_PATH, null, state.project);
    if (r.conflict) conflicts.push(r.conflict); else if (r.action && r.action.op !== 'unchanged') actions.push(r.action);
  }
  void src;
  return { actions, conflicts };
}

// ---- public API ------------------------------------------------------------
const norm = (o = {}) => ({ context7: o.context7 === true, optionalAgents: sortStr(o.optionalAgents ?? []), sddHandoff: o.sddHandoff === true });
const pick = (actions, op) => actions.filter((a) => a.op === op).map((a) => a.path);
const summarize = (status, actions, conflicts, src, finalSet) => ({ status, conflicts, created: pick(actions, 'create'), updated: pick(actions, 'update'), removed: pick(actions, 'remove'), unchanged: pick(actions, 'unchanged'), standard: { version: src.version, commit: src.head }, providers: finalSet });

// The handoff runtime exists for Claude Code and Codex only; asking for it without one of them is an error, never a silent no-op.
// The flag applies to the handoff-capable providers requested; Cursor never receives it. Both providers would own the same
// .dac/runtime/sdd-handoff files, so one project carries the runtime for exactly one provider.
function checkHandoff(requested, opts) {
  if (opts.sddHandoff && !requested.some((p) => HANDOFF_PROVIDERS.includes(p))) throw new AdapterError('OPTIONS', 'the SDD handoff runtime is only supported for claude-code and codex');
  if (opts.sddHandoff && requested.filter((p) => HANDOFF_PROVIDERS.includes(p)).length > 1) throw new AdapterError('OPTIONS', 'the SDD handoff runtime can be installed for only one provider at a time');
}
const forProvider = (p, opts) => ({ ...opts, sddHandoff: opts.sddHandoff && HANDOFF_PROVIDERS.includes(p) });
function checkSingleOwner(finalSet, optionsFor) {
  if (finalSet.filter((p) => HANDOFF_PROVIDERS.includes(p) && optionsFor(p).sddHandoff).length > 1) throw new AdapterError('OPTIONS', 'the SDD handoff runtime is already installed for another provider in this project; remove it there first (one owner of .dac/runtime/sdd-handoff)');
}

function checkProviders(list) {
  if (!Array.isArray(list) || !list.length || list.some((p) => !PROVIDERS.includes(p)) || new Set(list).size !== list.length) throw new AdapterError('PROVIDER', `providers must be a non-empty unique subset of ${PROVIDERS.join(', ')}`);
  return sortStr(list);
}

// Shared prelude for every command that can mutate: verify source, resolve target, read state.
function begin(target) {
  const src = verifySource(REPO_ROOT);
  const root = resolveTarget(target);
  return { src, root, state: readState(root) };
}

// Final gate: recheck the checkout immediately before the first write.
function recheck(src, hooks) {
  hooks?.afterPlan?.();
  const now = verifySource(REPO_ROOT);
  if (now.head !== src.head || now.tree !== src.tree) throw new AdapterError('SOURCE_CHANGED', 'standard source changed during the operation; no files were written');
}

function commit(root, src, state, { actions, conflicts }, finalSet, { dryRun, faultAfter, hooks, pruneDirs, okStatus }) {
  if (conflicts.length) return summarize('CONFLICT', actions, conflicts, src, finalSet);
  const changes = actions.filter((a) => a.op !== 'unchanged');
  if (!changes.length) return summarize('UNCHANGED', actions, conflicts, src, finalSet);
  if (dryRun) return summarize('DRY_RUN', actions, conflicts, src, finalSet);
  recheck(src, hooks);
  executeActions(root, changes, { faultAfter, pruneDirs });
  return summarize(okStatus, actions, conflicts, src, finalSet);
}

export function apply({ target, providers, options = {}, packageName, dryRun = false, faultAfter = null, hooks = null }) {
  const requested = checkProviders(providers);
  if (packageName !== undefined && !validPackageName(packageName)) throw new AdapterError('PACKAGE_NAME', `package name must be ${PACKAGE_NAME_RULE}`);
  const { src, root, state } = begin(target);
  const finalSet = sortStr(new Set([...state.installed, ...requested]));
  const opts = norm(options);
  checkHandoff(requested, opts);
  const optionsFor = (p) => (requested.includes(p) ? forProvider(p, opts) : state.providers.get(p).options);
  checkSingleOwner(finalSet, optionsFor);
  const plan = compose(root, state, src, finalSet, optionsFor, { requireSameCommit: true, packageName });
  // pruneDirs only removes directories emptied by this transaction's managed removals (e.g. disabling the handoff runtime).
  return commit(root, src, state, plan, finalSet, { dryRun, faultAfter, hooks, pruneDirs: true, okStatus: 'APPLIED' });
}

export function update({ target, dryRun = false, faultAfter = null, hooks = null }) {
  const { src, root, state } = begin(target);
  if (!state.installed.length) throw new AdapterError('NOT_INSTALLED', 'no bootstrapped or legacy provider installation found in the target');
  const plan = compose(root, state, src, state.installed, (p) => state.providers.get(p).options, { requireSameCommit: false });
  return commit(root, src, state, plan, state.installed, { dryRun, faultAfter, hooks, pruneDirs: true, okStatus: 'APPLIED' });
}

export function uninstall({ target, provider, dryRun = false, faultAfter = null, hooks = null }) {
  const [p] = checkProviders([provider]);
  const { src, root, state } = begin(target);
  if (!state.providers.has(p) && !state.conflicts.length) return summarize('UNCHANGED', [], [], src, state.installed);
  const plan = planUninstall(root, state, p, src);
  const finalSet = state.installed.filter((x) => x !== p);
  return commit(root, src, state, plan, finalSet, { dryRun, faultAfter, hooks, pruneDirs: true, okStatus: 'REMOVED' });
}

// Lists what would be generated; with a target, also dry-runs against it. Never writes.
export function plan({ providers, options = {}, target = null }) {
  const requested = checkProviders(providers);
  const src = verifySource(REPO_ROOT);
  const opts = norm(options);
  checkHandoff(requested, opts);
  const files = {};
  for (const p of requested) files[p] = [...genProvider(p, forProvider(p, opts)).files.keys()];
  const sharedOwners = requested.filter((p) => SHARED_PROVIDERS.includes(p));
  const out = { standard: { version: src.version, commit: src.head }, files, shared: sharedOwners.length ? [{ path: SHARED_AGENTS_PATH, owners: sharedOwners }] : [], records: [STANDARD_PATH, ...(sharedOwners.length ? [SHARED_PATH] : [])] };
  if (target) out.target = apply({ target, providers: requested, options, dryRun: true });
  return out;
}

export function verify({ target }) {
  const root = resolveTarget(target);
  const state = readState(root);
  const findings = state.conflicts.map((c) => ({ kind: 'invalid', path: c.path, reason: c.reason }));
  const check = (path, expected, what) => {
    const cur = inspect(root, path);
    if (cur.kind === 'missing') findings.push({ kind: 'missing', path, reason: `${what} is missing` });
    else if (cur.kind !== 'file') findings.push({ kind: 'invalid', path, reason: cur.reason });
    else if (sha256(cur.buf) !== expected) findings.push({ kind: 'modified', path, reason: `${what} differs from the recorded hash` });
  };
  for (const [p, st] of state.providers) {
    if (st.broken) continue;
    for (const f of st.manifest.files) check(f.path, f.sha256, `${p} managed file`);
    if (st.legacy) findings.push({ kind: 'legacy', path: MANIFEST_PATHS[p], reason: 'legacy provider manifest; run update to migrate' });
    const rec = state.standard.value?.providers[p];
    if (rec && (rec.adapter_version !== st.manifest.adapter_version || rec.context7 !== st.options.context7 || !same(rec.optional_agents, st.options.optionalAgents) || (rec.sdd_handoff === true) !== st.options.sddHandoff)) findings.push({ kind: 'modified', path: STANDARD_PATH, reason: `standard record disagrees with the ${p} manifest` });
  }
  if (state.entry) check(SHARED_AGENTS_PATH, state.entry.sha256, 'shared AGENTS.md');
  let source = { status: 'UNVERIFIED' };
  let outdated = null;
  try { const s = verifySource(REPO_ROOT); source = { status: 'OK', head: s.head }; if (state.standard.value) outdated = state.standard.value.standard_commit !== s.head; } catch (e) { source = { status: 'UNVERIFIED', code: e.code ?? 'SOURCE' }; }
  const status = !state.installed.length && !state.conflicts.length && state.standard.missing ? 'NOT_INSTALLED' : findings.length ? 'DRIFT' : 'OK';
  return { status, findings, providers: state.installed, standard: state.standard.value ? { version: state.standard.value.standard_version, commit: state.standard.value.standard_commit } : null, source, outdated };
}

// Read-only: the options each installed provider was installed with (context7 / optional agents / sdd_handoff). Used by the `dac` facade
// so re-running init reuses the existing engine with the recorded options. Never writes; conflicts are reported, not interpreted.
export function installedOptions({ target }) {
  const state = readState(resolveTarget(target));
  return { packageName: state.project.value?.package_name ?? null, providers: Object.fromEntries([...state.providers].filter(([, s]) => !s.broken).map(([p, s]) => [p, s.options])), broken: [...state.providers].filter(([, s]) => s.broken).map(([p]) => p), conflicts: state.conflicts };
}

// ---- CLI -------------------------------------------------------------------
const USAGE = `Usage: node installer/bootstrap.mjs <command> [options]
Commands:
  plan [--provider <p>...] [--target <dir>]   List generated files and effects; with --target also dry-run (no writes)
  apply --provider <p>... --target <dir>      Install providers (one transaction across providers and shared state)
  verify --target <dir>                       Check integrity and drift (no writes)
  update --target <dir>                       Explicitly move installed providers to this checkout's standard
  uninstall --provider <p> --target <dir>     Remove one provider; shared AGENTS.md is kept while another owner remains
  handoff <start|status|stop> --target <dir>  Operate the human-started SDD handoff custodian (foreground start; automatic endpoint)
Providers: ${PROVIDERS.join(', ')} (repeat --provider or comma-separate)
Options:
  --context7               Opt in to the Context7 template for the provider(s) being applied (off by default)
  --optional-agent <id>    claude-code only: also generate an optional catalog agent
  --sdd-handoff            claude-code or codex (one provider per project): install the SDD input-handoff runtime
                           (.dac/runtime/sdd-handoff, submit-only MCP proxy; .mcp.json for claude-code, .codex/config.toml entry for codex)
  --package-name <name>    apply: record the project's package name in the managed .dac/project.json (not an SDD project_id)
  --dry-run                Report actions without writing
  --json                   Machine-readable output
Requires this checkout to be a clean Git repository with a verifiable HEAD.`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, providers: [], context7: false, sddHandoff: false, packageName: undefined, optionalAgents: [], dryRun: false, json: false, target: undefined };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--context7') o.context7 = true;
    else if (a === '--sdd-handoff') o.sddHandoff = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--provider' && rest[i + 1]) o.providers.push(...rest[++i].split(','));
    else if (a === '--optional-agent' && rest[i + 1]) o.optionalAgents.push(rest[++i]);
    else if (a === '--package-name' && rest[i + 1] && o.packageName === undefined) o.packageName = rest[++i];
    else if (a === '--target' && rest[i + 1]) o.target = resolve(rest[++i]);
    else return { usage: `Unknown or incomplete option: ${a}` };
  }
  if (!['plan', 'apply', 'verify', 'update', 'uninstall'].includes(cmd)) return { usage: cmd === '--help' || cmd === '-h' ? '' : 'Unknown command', help: cmd === '--help' || cmd === '-h' };
  if (cmd !== 'plan' && !o.target) return { usage: '--target is required' };
  if (cmd === 'apply' && !o.providers.length) return { usage: '--provider is required' };
  if (o.packageName !== undefined && cmd !== 'apply') return { usage: '--package-name is only valid for apply' };
  if (cmd === 'uninstall' && o.providers.length !== 1) return { usage: 'uninstall takes exactly one --provider' };
  if (['verify', 'update'].includes(cmd) && (o.providers.length || o.context7 || o.optionalAgents.length || o.sddHandoff)) return { usage: `${cmd} does not take provider or template options` };
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.usage !== undefined) { console.error((o.usage ? o.usage + '\n' : '') + USAGE); return o.help ? 0 : 2; }
  const out = (obj, text) => console.log(o.json ? JSON.stringify(obj, null, 2) : text);
  const line = (r) => `${r.status}: created ${r.created.length}, updated ${r.updated.length}, removed ${r.removed.length}, unchanged ${r.unchanged.length}${r.conflicts.map((c) => `\nCONFLICT ${c.path}: ${c.reason}`).join('')}`;
  const options = { context7: o.context7, optionalAgents: o.optionalAgents, sddHandoff: o.sddHandoff };
  try {
    if (o.cmd === 'plan') {
      const r = plan({ providers: o.providers.length ? o.providers : PROVIDERS, options, target: o.target });
      out(r, [...Object.values(r.files).flat(), ...r.shared.map((s) => `${s.path} (shared: ${s.owners.join(', ')})`), ...r.records].join('\n') + (r.target ? `\n${line(r.target)}` : ''));
      return r.target?.status === 'CONFLICT' ? 1 : 0;
    }
    if (o.cmd === 'verify') {
      const r = verify({ target: o.target });
      out(r, `${r.status}${r.findings.map((f) => `\n${f.kind.toUpperCase()} ${f.path}: ${f.reason}`).join('')}`);
      return r.status === 'OK' ? 0 : 1;
    }
    const r = o.cmd === 'apply' ? apply({ target: o.target, providers: o.providers, options, packageName: o.packageName, dryRun: o.dryRun })
      : o.cmd === 'update' ? update({ target: o.target, dryRun: o.dryRun }) : uninstall({ target: o.target, provider: o.providers[0], dryRun: o.dryRun });
    out(r, line(r));
    return r.status === 'CONFLICT' ? 1 : 0;
  } catch (e) {
    console.error(e instanceof AdapterError ? `${e.code}: ${e.message}` : `bootstrap failure: ${e.message}`);
    return 1;
  }
}

// `handoff <start|status|stop> --target <dir>`: thin facade over the independent, human-operated custodian CLI. No environment variable and
// no runtime path to type: the endpoint is resolved automatically (platform + uid). `start` runs in the foreground (Ctrl-C stops it).
// It does not touch the project or the standard (no Git source gate needed) and adds no option the custodian CLI does not already have.
async function handoffMain(argv) {
  const [, sub, ...rest] = argv;
  if (!['start', 'status', 'stop'].includes(sub) || rest.length < 2 || rest[0] !== '--target' || !rest[1] || rest.slice(2).some((a) => a !== '--json')) {
    console.error('Usage: node installer/bootstrap.mjs handoff <start|status|stop> --target <dir> [--json]');
    return 2;
  }
  const { main: custodian } = await import('../adapters/shared/sdd-handoff/custodian-cli.mjs');
  return custodian([sub, ...rest]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === 'handoff') { const code = await handoffMain(process.argv.slice(2)); if (code !== null) process.exitCode = code; } // null: `start` keeps running
  else process.exitCode = main(process.argv.slice(2));
}
