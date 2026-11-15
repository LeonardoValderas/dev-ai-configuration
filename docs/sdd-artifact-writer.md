# SDD Artifact Writer

> **Implemented (Phase 2J-B).** The writer, its CLI, the schemas and the
> `sdd-artifact-write` gate exist in this repository. This document is the contract
> they implement. It is provider-neutral: Claude Code, Codex and Cursor see the same
> contract; there is no provider parameter anywhere.

Where things live:

- writer module and `plan` / `apply` / `verify` entry points:
  `adapters/shared/sdd-writer/writer.mjs`;
- CLI: `node adapters/shared/sdd-writer/cli.mjs <plan|apply|verify>` (also
  `npm run sdd-writer -- ...`);
- content and path policy: `adapters/shared/sdd-writer/artifacts.mjs`; authorization and
  trusted terminal: `authorization.mjs`; lock: `lock.mjs`;
- schemas: `standards/schemas/sdd-constitution.schema.json`,
  `sdd-specify.schema.json`, `sdd-write-receipt.schema.json`;
- gate: `sdd-artifact-write` in `standards/sdd/sdd-workflow.json`.

Implemented scope: the **Constitution** and **Specify** artifacts (and their optional
derived Markdown). `plan.json`, `tasks.json` and `traceability.json` are not writable
yet: they are not on the allowlist, so the writer refuses them.

Current SDD data and checks are described in [sdd.md](sdd.md). The bootstrap
that installs provider files is [project-bootstrap.md](project-bootstrap.md).

## 1. Purpose and non-goals

SDD artifacts (Constitution, Specify output, plan, tasks, traceability) are today
produced by agents as conversation content. The Artifact Writer is a deterministic,
provider-neutral, transactional component that persists **validated** SDD
documentation into a project, only after explicit local human authorization.

Non-goals: it is not a general workspace writer; it never writes code, tests,
scripts or configuration; it never executes model content; it never satisfies the
`pre-implementation` gate; it does not depend on any specific host, orchestrator
or provider; it uses no global state or global configuration; it has no bypass
mode, force flag or environment override.

## 2. Canonical storage (project-owned)

Artifacts live under a project-owned root, separate from the bootstrap-owned
`.dac/` and from the provisional Spec Kit paths `.specify/` and `specs/`:

```text
.sdd/
  artifacts/<project-id>/
    constitution.json      canonical (JSON is the source of truth)
    specify.json
    plan.json
    tasks.json
    traceability.json
    constitution.md        optional derived view, never authoritative
    specify.md
    plan.md
    tasks.md
  receipts/<project-id>/<sequence>-<plan-digest-prefix>.json
  consumed/<project-id>/<nonce>.json     one-use authorization markers
```

- `<project-id>` matches the existing `id` pattern from `common.schema.json`.
- JSON files are canonical (stable key order, UTF-8, LF, trailing newline). Markdown
  is optional and **OFF by default**: it is generated only when the plan/digest
  explicitly requests it, so the request is covered by the approved digest. It is
  derived by the writer from the JSON, never authoritative, and ignored by
  verification except for byte-equality with its own regeneration. Hand edits to
  Markdown are drift.
- Receipts and consumed markers are append-only: the writer creates, never updates.
- Lock files live under `.sdd/locks/` (section 7).
- `.sdd/` is **project-owned**. Bootstrap `apply`, `update` and `uninstall` never
  create, modify, prune or remove anything under `.sdd/`. Bootstrap ownership is
  limited to `.dac/standard.json`, `.dac/shared.json`, its managed provider files
  and the shared `AGENTS.md` ledger. `.specify/` and `specs/` are provisional
  Spec Kit paths, are not used by the writer and are not touched by it.
- The writer never reads or writes `.dac/`.

## 3. Operations: plan, apply, verify

Provider-neutral; each operation is a pure function of explicit inputs and the
target directory.

**plan** (no writes). Input: target directory, project id, operation, proposed
artifact content, standard commit. It validates content against the artifact
contracts in `standards/sdd/sdd-workflow.json`, resolves every destination against
the allowlist (section 5), reads current on-disk state, and returns a canonical
plan: ordered list of `{path, op, before_sha256, after_sha256}` plus validation and
traceability results. The canonical plan is serialized deterministically and
hashed (`plan_digest`). Any error yields zero writes and no authorization request.

**apply** (writes). Input: the plan inputs again plus a one-use authorization
(section 4). `apply` recomputes the plan from scratch, compares `plan_digest`,
revalidates the authorization and the on-disk prior state immediately before the
first write, then writes in one transaction (section 7). It never trusts a
previously returned plan object.

**verify** (no writes). Re-reads disk and checks artifacts against the latest
receipt: hashes, schema validity, referential integrity, derived Markdown, receipt
chain. Reports drift; never repairs.

**Input and flow.** `--input` is a JSON file (never stdin) with `project_id`,
`operation` (`create` | `update`), optional `markdown` (boolean, default `false`) and
one or both of `constitution` and `specify`
(see the two schemas). `apply` has no authorization argument: after the lock is held and
the plan recomputed, the writer mints the authorization (nonce, `issued_at`,
`expires_at = issued_at + 600 s`), opens `/dev/tty` itself, prints the exact plan and
digest, and requires the human to type `approve <digest prefix> <nonce prefix>`. Any
other answer, or no terminal, is a refusal with zero writes. `--recover-lock` only
offers stale-lock recovery (section 7). Unknown options, including `--yes`, are usage
errors. The operational result lists `files_changed` exactly (artifacts that changed,
the receipt and the consumed marker; empty on failure unless a rollback failed, in
which case it lists the paths that could not be restored).

## 4. Human authorization

A bare SHA or digest is insufficient: a digest proves integrity, not consent. An
authorization is a structured record bound to all of:

| Field | Meaning |
| --- | --- |
| `plan_digest` | SHA-256 over the canonical plan |
| `target` | real target identity: `realpath` plus device and inode, not a user-supplied label |
| `operation` | `create` / `update` of the named artifact set |
| `project_id` | SDD project id |
| `prior_state` | per-path before hashes, including explicit `missing` for absent files |
| `standard_commit` | full 40-hex commit of the standard in use |
| `nonce` | random, single-use |
| `issued_at`, `expires_at` | UTC timestamps; TTL below |

Decisions (closed):

1. **Mandatory trusted interactive terminal.** In the MVP, approval exists only
   when the writer itself opens an interactive terminal, requires a TTY, and
   displays the exact plan and digest to the human. None of the following is an
   approval: a JSON file or record on its own, a command-line argument, an
   environment variable, stdin or a pipe, a `--yes` style flag, or model text. The
   model cannot self-approve. Without a TTY the writer fails closed.
2. **Existing `sdd-project` approvals do not authorize this write.** Approvals
   recorded for `pre-implementation` and the other gates are a different consent.
3. **TTL is exactly 10 minutes (600 seconds)**: `expires_at - issued_at` must equal
   600 s. A future `issued_at` is tolerated by at most 30 seconds of clock skew;
   skew never extends `expires_at`. Time is checked after the lock is acquired and
   again immediately before the first write. Exactly at `expires_at` is expired.
   The interactive confirmation has its own timeout: `min(configured confirmation
   timeout (default 120 s), time remaining until expires_at)`; the 30 s skew
   tolerance is never added to it. If nothing is confirmed in time (or no time is
   left) the writer fails with `APPROVAL_TIMEOUT`: zero artifact writes, the nonce is
   not consumed (no consumed marker), the terminal it opened is closed and only the
   lock it owns (token match) is released.
   The terminal polls non-blockingly every 25 ms, so a timeout is detected within
   about 25 ms (plus scheduling) after the deadline; a confirmation line completed
   after the deadline is rejected even if the human was mid-typing. Real-PTY tests
   (`22`, `22b`, `22c`, including slow input near `expires_at` proving zero writes
   and no consumed nonce) need python3 with `pty`; without it they are an explicit
   Node SKIP in `npm test`. The macOS gate `npm run test:pty-gate` sets
   `DAC_REQUIRE_PTY=1` and BLOCKS (exit 1) if they cannot run or any is skipped.
   **CI disclosure:** `npm run test:pty-gate` is NOT wired into the current GitHub
   Actions workflow. Current CI runs on Ubuntu, where ordinary tests may explicitly
   SKIP the PTY tests when python3/pty is unavailable. Until a macOS CI job exists,
   running `npm run test:pty-gate` on macOS is a manual, mandatory operator gate
   before merge/release. If that gate cannot execute all expected PTY tests, the
   status is BLOCKED.
4. **Recompute and revalidate** the plan, prior state (full check under lock) and
   standard commit immediately before writing. Any difference fails closed.
5. **Expired, altered or replayed** authorization fails with **zero writes**. Replay
   is detected by a consumed marker for the nonce (written inside the same
   transaction as the artifacts) and by the prior-state binding.
6. An authorization authorizes one plan once. It is never reusable across
   targets, projects, operations or standard commits.

Residual risk: a same-user process can drive a pseudo-terminal, so the TTY prompt
is not claimed to be unforgeable and is not a boundary against a hostile local
user of the same account. Model output, tool results and repository content are
never an approval.

## 5. Path policy and untrusted content

Exact allowlist: only the paths named in section 2 for the given project id. Anything
else is rejected, with zero writes. Reject:

- absolute paths, drive prefixes, `..` segments, empty or `.` segments, backslashes;
- symlinks anywhere in the destination chain, and non-regular existing files
  (directories, devices, sockets, FIFOs, hard-link surprises where detectable);
- case aliases and Unicode aliases (compare NFC and case-folded forms against the
  allowlist; refuse a destination whose folded form collides with a different
  existing entry);
- executable, code, test, script and configuration destinations (for example
  `.js`, `.mjs`, `.ts`, `.sh`, `.json` outside the allowlist, `package.json`,
  `.github/`, hooks, provider settings);
- anything under `.dac/`, `.specify/`, `specs/`, `.git/`, or outside the target.

All model-produced content is untrusted **data**: parsed as JSON/text, validated,
size-limited, never evaluated, never used to choose a path, command or
authorization. Derived Markdown is generated by the writer from validated JSON, so
model text cannot inject structure outside its fields.

## 6. The `sdd-artifact-write` gate

A gate separate from `pre-implementation`, defined in `sdd-workflow.json` and applied by
every mode (conditions: `artifacts-validated`, `path-allowlist-confined`,
`plan-digest-bound`, `trusted-terminal-approval`; no other gate may borrow them):

- It permits exactly one thing: persistence of managed SDD documentation through
  the writer.
- It is **additional, never a substitute**. It **never** satisfies or implies
  `pre-implementation`, `pre-migration`, `pre-production-mutation` or
  `pre-deployment`. Writing a Specify artifact does not approve implementing it,
  and code still requires a granted `pre-implementation`.
- `code-reviewer` and other specialists remain read-only; they may review a plan or
  a receipt but cannot hold or exercise the write authorization.
- It requires human approval (section 4).

Wording change made in 2J-B: the `pre-implementation` "blocks" text used to read "the
implement phase and any file change". It now says it covers implementation, code,
tests, scripts and configuration outside the exact SDD documentation allowlist; files
inside that allowlist are governed by `sdd-artifact-write`. Approving documentation
therefore never authorizes code changes, and `checkWorkflow` rejects the old wording.

Future gate wiring touch points (wired in 2J-B unless noted; the agent map and the
`dac-scope-guard` hook scope are intentionally unchanged because the writer is not an
agent and no agent gains Write/Edit):
`standards/sdd/sdd-workflow.json` (gate and wording), `standards/schemas/` (gate
and artifact/plan/authorization/receipt schemas), `standards/sdd/sdd-agent-map.json`,
`installer/lib/sdd.mjs` (hardcoded five-gate set and approval rules),
`adapters/shared/canonical.mjs` and the generated SDD rules, `docs/sdd.md`,
`tests/sdd.test.mjs` and fixtures, and the `dac-scope-guard` hook scope.

## 7. Transaction, locking and reuse

There is no second transaction engine. Implemented design: a thin writer **outside `installer/`** (guarded as
read-only/no-write by validators) computes the actions and calls the shared
`executeActions` from `adapters/shared/apply.mjs`, **extended with an optional
in-transaction verification callback** and **honest rollback-failure reporting**
(a failed restore is reported as such, never as a clean rollback). It reuses
confinement, symlink rejection, per-action `create`/`update` previous-bytes
rechecks and journaled rollback. Artifacts, the receipt and the consumed marker go
in one action list that never contains `remove` actions. The writer additionally
performs a full prior-state check under the lock, and the executor's per-action
checks remain the second line.

**Lock.** One exclusive lock per target/project under `.sdd/locks/`, created
exclusively (fail if it exists). It records: owner token, pid, host, process start
time, project id, target identity, creation time. Rules:

- acquired **before** recomputing the plan, held through verification, released
  only when the token matches;
- an existing lock yields `LOCKED`; it is never removed because of age alone;
- recovery requires a trusted terminal plus verification that the owner is on the
  same host, dead, and that start time and token match; then the writer verifies the
  target state. Otherwise it refuses;
- the lock lifecycle is a writer-owned **exception outside the `executeActions`
  action list** (the executor never removes; the lock must be released after it);
- bootstrap and the writer do not share a lock: their path sets (`.dac/` and
  managed provider files versus `.sdd/`) are disjoint.

Known limits inherited from the shared executor, to be restated in 2J-B:

- the journal is in-process: a **hard kill** (SIGKILL, power loss) mid-apply can
  leave a partial state and leftover `.dac-tmp` temp files that are not rolled back
  automatically; `verify` must detect both (missing receipt, hash mismatch,
  `.dac-tmp` leftovers) and report, not repair;
- rollback is **best effort**: a restore can itself fail, and the result must say so;
- owner verification is strict and fail-safe. Liveness uses `ps -o lstart= -p <pid>`
  (POSIX `ps` as on macOS and Linux procps) compared with the start time recorded in
  the lock. The same probe is first run on the writer's own pid; if it does not
  work (no `ps`, unsupported option, busybox/restricted environments, Windows) or
  the lock has no recorded start time, the owner is `unverifiable` and recovery is
  refused. Same-host only, never by age, and `lstart` has one-second resolution (a
  recycled pid started within the same second as the original is indistinguishable;
  the terminal confirmation is the remaining safeguard). On such platforms a stale
  lock must be removed manually by a human after inspection;
- the lock is advisory between cooperating writer processes; a non-cooperating
  process can still modify files, mitigated only by the prior-state rechecks;
- records are not signed.

## 8. Receipts and verification

Each successful `apply` writes a receipt containing: `plan_digest`, authorization
id (nonce) and timestamps, project id, operation, standard commit, previous receipt
digest (chain), and per file `{path, op, before_sha256, after_sha256}`; the **actual
result** `files_changed` (what the executor really wrote, not the plan); validation
and traceability results; and the outcome of **post-write disk verification**
(every written file re-read and hash-compared). If post-write verification fails,
the writer restores prior bytes through the journal approach and reports failure
evidence (which path, expected and observed hash, rollback result). A failed attempt
with zero writes records evidence in the returned result only, because it must not
create files.

Changed artifact paths are reported in the operation result and receipt. The writer
**must not populate** `files_changed` of an `sdd-project` record: that field keeps
its current meaning (files changed by implementation, checked against task paths and
scope). Artifact paths are not implementation changes.

## 9. Validation rules (content)

- Constitution: valid shape, non-empty principles, no duplicate ids.
- Specify: requirements and acceptance criteria satisfy the `requirements` and
  `acceptance-criteria` contracts; **duplicate requirement ids** rejected; every
  criterion references an existing requirement (**orphan criteria** rejected); every
  requirement has at least one criterion.
- Later artifacts: references resolve (decision to requirement, task to requirement
  and criterion), per the traceability kinds of the active mode.

## 10. Acceptance criteria for Phase 2J-B

1. `plan` and `verify` perform zero writes.
2. Every failure path (validation, path policy, drift, authorization, lock) leaves
   the target byte-identical.
3. Authorization is bound to every field in section 4; expired, tampered and replayed
   authorizations fail with zero writes.
4. Without a TTY, or with only a JSON file, argument, environment variable, stdin,
   `--yes` or model text, the writer refuses with zero writes; an existing
   `sdd-project` approval is not accepted.
5. TTL is exactly 600 s; `issued_at` more than 30 s in the future is rejected; skew
   never extends `expires_at`; expiry is checked after the lock and immediately
   before the first write, and `expires_at` itself is expired.
6. Plan and full prior state are recomputed under the lock, immediately before the
   first write.
7. Only allowlisted `.sdd/` paths are writable; the path policy of section 5 holds;
   `.dac/` is never touched.
8. Writes go through the extended `executeActions`; no second engine; no `remove`
   actions; the lock file is the only writer-owned exception.
9. A held lock yields `LOCKED`; a foreign or aged lock is never removed
   automatically; recovery follows section 7 or refuses.
10. Receipts contain section 8 evidence; post-write verification runs in the
    transaction; `verify` reports `.dac-tmp` leftovers.
11. A rollback failure is reported honestly, with the paths that could not be
    restored.
12. `sdd-project.files_changed` is never populated by the writer.
13. Bootstrap `apply`, `update`, `uninstall` and rollback leave `.sdd/` byte-identical.
14. The `sdd-artifact-write` gate does not satisfy `pre-implementation`, and the
    `pre-implementation` wording is narrowed as described in section 6.
15. Fails closed without a trustworthy human channel; `code-reviewer` stays read-only.

## 11. Test matrix (`tests/sdd-artifact-writer.test.mjs`)

Valid and invalid Constitution; valid and invalid Specify; duplicate requirements;
orphan criteria; absolute path, traversal, symlink (file and directory), case and
Unicode aliases, non-regular files, executable/code/test/script/config destinations;
drift between plan and apply; no TTY, JSON-only, argument, environment variable,
stdin and `--yes` rejection; model self-approval; sdd-project approval reuse;
authorization tamper per field, replay, TTL at 599/600/601 seconds, issued_at skew
at 30/31 seconds, expiry between lock and first write; lock contention, foreign
lock, aged lock not removed, recovery with dead owner versus live owner or token
mismatch; `.dac-tmp` leftovers detected by verify; partial failure with rollback
(fault injection), rollback failure reporting and post-write verification failure;
bootstrap apply, update, uninstall and rollback preserving `.sdd/` byte for byte;
receipt integrity and chain; zero writes on every failure; gate separation from
`pre-implementation`.

## 12. Open decisions and risks

Real unresolved items only (everything in sections 2 to 7 is decided):

- Behavior of the trusted terminal on Windows consoles.
- Receipt sequencing and the exact hard-kill recovery procedure beyond detection
  (after lock recovery the writer only verifies; it never repairs).
- Whether the consumed marker store is bounded or pruned (pruning would weaken replay
  detection).
- Schema versioning beyond `1.0` of artifacts and receipts; `plan`, `tasks` and
  `traceability` artifacts are not yet writable.
- Risk: a same-user process can imitate a TTY; local confirmation raises the bar but
  is not a security boundary against a hostile local user.
- Risk: inherited hard-kill, temp-file and best-effort rollback limits (section 7).
