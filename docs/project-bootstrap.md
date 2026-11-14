# Project bootstrap design (Phase 2I-A)

**Status: DESIGN ONLY.** Nothing in the "Proposed" sections exists. The future
common CLI is **NOT EXECUTABLE in Phase 2I-A**. Do not run, script or document
`verify`, `update` or a common CLI as available. Implementation is the scope of
Phase 2I-B.

## 1. Principles

- Project-scoped: writes only inside the target project; no user-level or global config.
- Versioned per project: each project records which standard version/commit it received.
- No absolute machine paths and no OpenClaw (or other host-specific) references in generated files or records.
- Context7 stays off by default.
- Spec Kit is never auto-installed; SDD is a methodology, not an installer.
- No promise of code execution: generated files are declarative configuration. Authenticated enforcement by providers is **UNVERIFIED**.
- Reuse `createInstaller` in `adapters/shared/apply.mjs` (journaled rollback, conflict detection, safe uninstall). No second installer.

## 2. Commands available TODAY (real)

Run from a clone of this repository. `--target` must be an existing project directory.

```
node adapters/claude-code/cli.mjs plan [--enable-context7] [--optional-agent <id>] [--json]
node adapters/claude-code/cli.mjs apply --target <dir> [--enable-context7] [--optional-agent <id>] [--dry-run] [--json]
node adapters/claude-code/cli.mjs uninstall --target <dir> [--dry-run] [--json]

node adapters/codex/cli.mjs plan [--include-context7-template] [--json]
node adapters/codex/cli.mjs apply --target <dir> [--include-context7-template] [--dry-run] [--json]
node adapters/codex/cli.mjs uninstall --target <dir> [--dry-run] [--json]

node adapters/cursor/cli.mjs plan [--include-context7-template] [--json]
node adapters/cursor/cli.mjs apply --target <dir> [--include-context7-template] [--dry-run] [--json]
node adapters/cursor/cli.mjs uninstall --target <dir> [--dry-run] [--json]
```

Exit codes: 0 ok, 1 conflict or failure, 2 usage error. Each provider records its own
managed manifest (`.claude/dac-manifest.json`, `.codex/dac-manifest.json`,
`.cursor/dac-manifest.json`) with `adapter_version` and per-file SHA-256, but **no standard
version or git commit**.

State today: a `verify` command, an `update` command and a common CLI **do not exist**.
Verification today is `apply --dry-run` plus inspecting the managed manifest; update today is
re-running `apply` from a newer checkout.

Provider outputs today: Claude Code writes `.claude/**` and does **not** create `CLAUDE.md`.
Codex and Cursor each emit a provider-specific root `AGENTS.md` (see section 8).

## 2a. Provider workflows

Prerequisite per provider (not installed by this repository): Claude Code CLI; Codex CLI;
Cursor IDE and/or Cursor Agent CLI (distinct surfaces; the adapter writes project files
usable by both, but capability and enforcement evidence differs). Use **one** provider per
project today (see section 8).

| Step | Claude Code | Codex | Cursor |
|---|---|---|---|
| 1. Select adapter | `adapters/claude-code/cli.mjs` | `adapters/codex/cli.mjs` | `adapters/cursor/cli.mjs` |
| 2. Dry-run, then apply | `apply --target <dir> --dry-run`, then `apply --target <dir>` | same | same |
| 3. Open in target | `cd <dir>`, then launch the installed Claude Code CLI | `cd <dir>`, then launch the installed Codex CLI | `cd <dir>`, then open the folder in the Cursor IDE or launch the Cursor Agent CLI using its installed launcher |
| 4. First SDD record | Ask it to write the first specification / project record per [sdd.md](sdd.md), choosing Full, Lightweight or Hotfix | same | same |

Run steps 1-2 as `node adapters/<provider>/cli.mjs ...` from a clone of this repository. If
the exact launch invocation of a provider is not known, use that provider's installed
launcher. Asking for a specification first is guidance, not enforcement: the adapter does not
execute SDD, does not install Spec Kit, and enforcement stays **UNVERIFIED**. Do not request
implementation before the SDD gates pass.

## 3. Proposed common CLI (PROPOSED, NOT EXECUTABLE)

> PROPOSED for Phase 2I-B. NOT EXECUTABLE today. Names and flags may change.

Delegates to the provider generators and `createInstaller`; adds no new write path.

| Command | Status | Intent |
|---|---|---|
| `plan --provider <p>` | PROPOSED / NOT EXECUTABLE | No-write listing of files, conflicts and shared-ownership effects. |
| `apply --provider <p> --target <dir>` | PROPOSED / NOT EXECUTABLE | Applies via `createInstaller`, supports `--dry-run`, records standard version/commit. |
| `verify --target <dir>` | PROPOSED / NOT EXECUTABLE | No-write: compares files to the record and manifests; reports drift, missing, foreign files. |
| `update --target <dir>` | PROPOSED / NOT EXECUTABLE | Explicit only; shows a diff plan first; never runs implicitly. |
| `uninstall --provider <p> --target <dir>` | PROPOSED / NOT EXECUTABLE | Removes only unmodified files owned solely by that provider. |

## 4. Proposed per-project standard record (PROPOSED)

A project-relative file, e.g. `.dac/standard.json` (PROPOSED, does not exist):

```json
{
  "schema": 1,
  "standard_version": "0.1.0-dev",
  "standard_commit": "<40-hex git commit of this repository>",
  "providers": { "codex": { "adapter_version": "0.1.0" } }
}
```

No absolute paths, hostnames or user names. Written with the same journal as the provider files.

Before a future `apply` writes anything, the bootstrap must resolve the standard source as a
valid Git checkout with a clean working tree and a verifiable `HEAD`. It records the full
40-hex SHA of that `HEAD` as `standard_commit`. If the source is not a Git checkout, is dirty,
or its commit cannot be verified, `apply` must fail closed with **zero writes**. It must never
substitute a synthetic value, use a shortened SHA, or record a commit that does not represent
the exact content being applied. This is a Phase 2I-B design contract only; no executable
check exists in Phase 2I-A.

## 5. Existing project behavior

Preflight inspects every planned path before any write. Rules for `CLAUDE.md`, `AGENTS.md`,
`.claude/`, `.codex/`, `.cursor/`, `.agents/` and whole-file configs (e.g. `settings.json`,
`.mcp.json`, `config.toml`):

- Path missing: create.
- Path exists, byte-identical: unchanged.
- Path exists, not managed by us (or modified since install): **CONFLICT**; the whole run
  performs **zero writes**.
- No silent merge and no silent overwrite, ever. Whole-file configs are owned entirely or not at all.
- Symlinks and paths escaping the target are rejected.
- `CLAUDE.md` is not generated today; if a future version generates it, the same rules apply.

## 6. Update, rollback and uninstall policies

- Update is explicit, preceded by a plan, and applied only to files whose on-disk hash still
  matches the manifest. User-modified managed files are conflicts, not overwritten.
- Rollback: any fault during apply restores the pre-run state from the journal (exists today
  per provider).
- Uninstall removes only unmodified files recorded in the manifest; modified files are kept and reported.
- **Cross-provider atomicity decision:** a multi-provider apply must be atomic across all selected
  providers (one journal, one plan, one conflict check) in 2I-B; if that cannot be delivered,
  the common CLI must refuse multi-provider apply rather than apply sequentially.

## 7. Distribution on a new Mac

Clone, then run the real commands in section 2. Nothing is installed globally.

## 8. Codex/Cursor `AGENTS.md` collision (KNOWN ISSUE, not solved today)

Both Codex and Cursor emit a root `AGENTS.md` and keep separate ledgers. Applying both
produces a conflict, and uninstalling one could remove or orphan a file the other owns.
**Do not apply both today.**

Proposed resolution (does **not** exist):

- A provider-neutral, shared canonical `AGENTS.md`, rendered identically regardless of provider.
- A shared ownership ledger with reference counts, e.g. `.dac/shared.json`, listing each
  shared path, its SHA-256 and the set of owning providers.
- apply: creating a shared file adds the provider to its owners; if the file exists with
  identical content and is in the ledger, add an owner without rewriting.
- update: rewrite only if the on-disk hash matches the ledger; all owners receive the same canonical content.
- uninstall: remove the provider from owners; delete the file only when the owner set becomes
  empty and the file is unmodified.
- migration: a legacy provider-specific `AGENTS.md` recorded in a provider manifest is moved
  into the shared ledger only if its hash equals the canonical content; otherwise CONFLICT.

Required mixed-provider tests (2I-B): codex then cursor; cursor then codex; uninstall one keeps
`AGENTS.md`; uninstall both removes it; modified `AGENTS.md` conflicts with zero writes; fault
injection mid-apply rolls back both ledgers; legacy migration.

## 9. macOS distribution gate

- Static Ubuntu CI: schema validation, generation, installer tests. It cannot prove provider CLIs run on macOS.
- Real macOS gate: `--version`/`--help` probes of provider CLIs in an OS sandbox, never authenticating
  or calling a model. A sandbox refusal is reported as unverified.
- Authenticated enforcement (whether providers honor read-only/deny settings) remains **UNVERIFIED**.
  Distribution must not claim it.

## 10. Acceptance criteria for 2I-B

1. `plan` and `verify` perform no writes (tested by tree snapshot).
2. `update` runs only when explicitly invoked.
3. Any conflict yields zero writes.
4. Apply is idempotent (second run: all unchanged).
5. Injected faults roll back completely.
6. Uninstall is ownership-safe, including shared files.
7. Standard version and git commit are recorded, and no absolute path appears in any generated file.
8. Mixed-provider `AGENTS.md` tests in section 8 pass.
9. Context7 is off by default.
10. No Spec Kit install, no global/user-level writes, no OpenClaw references.
11. The macOS gate in section 9 is run and its result recorded; authenticated enforcement stays UNVERIFIED.

## 11. Risks and pending decisions

- Shared ledger format and migration of existing provider-specific installs.
- Whether multi-provider apply is truly atomic or refused.
- Detecting source-checkout changes between preflight and the transactional write remains a
  TOCTOU risk for 2I-B; the resolved clean `HEAD` must remain the content source throughout
  one operation.
- Cursor IDE vs Agent CLI behavior differs; enforcement unverified for both.
- Provider native support for `AGENTS.md` may change.
