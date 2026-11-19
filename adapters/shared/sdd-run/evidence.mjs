// Evidence classes shown to the read-only reviewer. Four DISTINCT classes, never merged and never rewritten:
//   1. implementation evidence  - what the implementer claimed/recorded; NOT independent
//   2. independent validation   - what dac itself executed (validation.mjs) against the exact audited content
//   3. declared controls        - profiles and contract constraints as DECLARED; declaration is not proof of enforcement
//   4. observed actions / audit - what the post-run audit actually inspected, and what it cannot observe
// "Not observed" is never translated into "did not occur". Everything is bounded and redacted; full records stay in the run directory.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from '../sdd-writer/artifacts.mjs';
import { safeExcerpt } from './runners.mjs';
import { fileSha, readJson } from './store.mjs';
import { criterionEvidence } from './criteria-evidence.mjs';

const T = (s, n = 300) => safeExcerpt(s, { causalOnly: false, maxLines: 6, maxLineChars: n, maxBytes: n * 3 });
const list = (a, n = 20) => (Array.isArray(a) ? a.slice(0, n).map((x) => T(x)) : []);

export function collectEvidence({ root, run, audit, contract, runDir, reviewerProfile, validation }) {
  const result = readJson(join(runDir, 'result.json'));
  let files = []; try { files = readdirSync(runDir).filter((f) => /^implement-(last-message|transcript)(-\d+)?\.(txt)$/.test(f)).sort(); } catch { /* none */ }
  const implementation = {
    evidence_class: 'implementation evidence (NOT independent: produced by the implementer)',
    result: result ? { execution_status: result.execution_status, validation_result: result.validation_result, files_changed: list(result.files_changed, 50), warnings: list(result.warnings), unresolved_blockers: list(result.unresolved_blockers),
      claimed_evidence: (Array.isArray(result.evidence) ? result.evidence.slice(0, 20) : []).map((e) => ({ description: T(e?.description), command: T(e?.command), output_summary: T(e?.output_summary, 500) })) } : 'result.json is missing or unreadable',
    implementer_files: files.map((f) => { let bytes = null; try { bytes = statSync(join(runDir, f)).size; } catch { /* gone */ } return { file: f, bytes, sha256: fileSha(join(runDir, f)) }; }),
    note: 'These are the implementer\'s own claims and provider output. Transcripts are provider stdout/stderr, not a verified command log; their completeness is unverified. Do not treat any of it as independent verification.',
  };
  const p = run.runner.profile ?? {};
  const declared = {
    evidence_class: 'declared controls/profile (DECLARATIONS: not proof that they were enforced)',
    implementer_profile: { id: p.id, sandbox: p.sandbox, approval: p.approval, mcp: p.mcp, network: p.network, bypass: p.bypass, model: p.model ?? null, verified_against_real_binary: p.verified_against_real_binary ?? false },
    reviewer_profile: { id: reviewerProfile.id, sandbox: reviewerProfile.sandbox, approval: reviewerProfile.approval, mcp: reviewerProfile.mcp, network: reviewerProfile.network, bypass: reviewerProfile.bypass },
    contract_constraints: contract.constraints, authorized_validation_commands: contract.validation_commands,
  };
  const observed = {
    evidence_class: 'observed actions/audit (what dac inspected after the run; it does not record process or network activity)',
    audit: { status: audit.status, audit_hash: audit.audit_hash, content_hash: audit.content_hash, result_tree: audit.result_tree, diff_sha256: audit.diff_sha256, totals: audit.totals, violation_count: audit.violation_count, environment_checked: audit.environment_checked, warnings: list(audit.warnings) },
    inspected_at_audit_time: ['every file of the worktree (tracked, untracked and ignored) against the authorized base tree by content, type and mode', 'worktree HEAD, run branch ref, repository config/remotes/hooks/info, and the original project (index, files, DAC/provider directories) against their pre-run fingerprints', 'every change against the exact allowed/prohibited/protected paths and size ceilings'],
    not_observable_by_the_audit: ['network traffic or any network access', 'which commands ran (for example npm install) and when; only residue left inside the audited worktree is seen', 'transient or in-memory Git operations that left the fingerprinted locations unchanged (for example worktree index writes)', 'the completeness of the implementer transcript'],
    proven_by_profile_audit_and_transcripts: ['At audit time the final worktree content differed from the base ONLY by the audited changes, all inside the authorized paths (audit PASS, no violation; a leftover node_modules, ignored file or Git metadata change would have been a violation).', `Declared implementer network setting was ${JSON.stringify(p.network)} and the declared sandbox was ${JSON.stringify(p.sandbox)} (declared only${p.verified_against_real_binary === false ? '; profile argv NOT verified against a real binary' : ''}).`],
    unverified: ['Whether the implementer used the network (no observation either way).', 'Whether npm install or other package/download commands ran and left no residue.', 'Whether Git commands that write state ran without changing the fingerprinted locations.', 'Anything the implementer transcript does not contain.'],
    rule: 'Absence of an observation is NOT evidence that an action did not occur, and presence of a declaration is NOT evidence it was enforced. For any criterion about network use, package installation or Git writes, state precisely what the evidence above proves and what remains unverified; mark a criterion violated only on contradicting evidence, and do not change or reinterpret the criteria.',
  };
  const criteria = root ? criterionEvidence({ root, run, audit, contract, validation, profile: reviewerProfile }) : null;
  return { implementation, validation: validation ?? { evidence_class: 'independent validation evidence', status: 'NOT PERFORMED' }, declared, observed, criteria };
}

export function renderEvidence(ev) {
  if (!ev) return ['## Evidence', 'No evidence classes were supplied to this review; treat every claim as unverified.'];
  const block = (title, obj) => [`## ${title}`, '```json', JSON.stringify(canonicalize(obj), null, 2), '```', ''];
  return [
    '## Evidence classes (kept separate; do not merge them)',
    'Four evidence classes and a derived criterion matrix follow. Only "independent validation evidence" was produced by dac itself, before this review, from the exact reviewed content. Implementer claims are not independent evidence.',
    '',
    ...block('1. Implementation evidence (NOT independent)', ev.implementation),
    ...block('2. Independent validation evidence (executed by dac, bound to the audited content)', ev.validation),
    ...block('3. Declared controls/profile (declarations, not proof)', ev.declared),
    ...block('4. Observed actions/audit', ev.observed),
    ...(ev.criteria ? [...block('5. Criterion -> evidence matrix (derived, read-only; statuses: available / recoverable / not-recorded)', ev.criteria), 'Use the matrix to see which evidence exists for each criterion. Never treat absent, uninspected or not-recorded evidence as a pass; keep such criteria UNVERIFIED and return BLOCKED rather than PASS. Do not change or reinterpret the criteria.', ''] : []),
  ];
}
