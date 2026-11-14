# Project bootstrap (Phase 2I-B)

**Status: IMPLEMENTED** in `installer/bootstrap.mjs` (`plan`, `apply`, `verify`, `update`,
`uninstall`). Tests: `tests/project-bootstrap.test.mjs`. Provider enforcement of the generated
settings is **UNVERIFIED** and the macOS provider-CLI gate (section 9) is not part of this phase.

## 1. Principles

- Project-scoped: writes only inside the target project; no user-level or global config.
- Versioned per project: each project records the standard version and full commit it received.
- No absolute machine paths and no OpenClaw (or other host-specific) references in generated files or records.
- Context7 stays off by default (`--context7` is an explicit opt-in; it only generates an inert/disabled template, except for Claude Code where it generates the documented `.mcp.json`).
- Spec Kit is never installed; SDD is a methodology, not an installer.
- No promise of code execution: generated files are declarative configuration. Authenticated enforcement by providers is **UNVERIFIED**.
- One engine: the facade reuses the provider generators, the `createInstaller` planners and the shared journaled executor (`executeActions`) in `adapters/shared/apply.mjs`. It adds no second installer.

## 2. Commands

Run from a clone of this repository (clean Git checkout, see section 4). `--target` must be an
existing, absolute-resolvable project directory; `--provider` is repeatable or comma-separated.

```
node installer/bootstrap.mjs plan [--provider <p>...] [--target <dir>] [--context7] [--json]
node installer/bootstrap.mjs apply --provider <p>... --target <dir> [--context7] [--optional-agent <id>] [--dry-run] [--json]
node installer/bootstrap.mjs verify --target <dir> [--json]
node installer/bootstrap.mjs update --target <dir> [--dry-run] [--json]
node installer/bootstrap.mjs uninstall --provider <p> --target <dir> [--dry-run] [--json]
```

Providers: `claude-code`, `codex`, `cursor`. Exit codes: 0 ok, 1 conflict/failure/drift, 2 usage error.

| Command | Behavior |
|---|---|
| `plan` | No writes. Lists generated files per provider, shared artifacts and records. With `--target`, also dry-runs against the target and reports conflicts. |
| `apply` | Installs the requested providers on top of any already installed ones, in one transaction. Idempotent (second run: `UNCHANGED`). Refuses (CONFLICT) if the project was installed from a different standard commit: run `update`. Options apply to the requested providers; already installed providers keep their recorded options. |
| `verify` | No writes. Compares every managed file to its recorded hash, validates the `.dac` records and provider manifests, and reports `missing`, `modified`, `invalid` or `legacy` findings (status `OK`, `DRIFT` or `NOT_INSTALLED`; exit 0 only for `OK`). Also reports whether the checkout is newer (`outdated`). Does not require a clean source. |
| `update` | Explicit only (never run by `apply`/`verify`). Regenerates every installed provider from this checkout, keeping its recorded options, and moves the whole project to the checkout's version atomically. Drift is a CONFLICT with zero writes. Also migrates legacy installs. |
| `uninstall` | Removes one provider's unmodified files. Drift is a CONFLICT with zero writes (a deliberate change from the per-provider CLI, which keeps modified files). Empty directories it leaves are pruned. Last provider removes `.dac/`. |

### Per-provider commands (still available)

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

These produce the legacy single-provider layout (provider-specific `AGENTS.md`, no `.dac/`
records, no standard commit). Do not mix them with the bootstrap on a project that already
carries `.dac/` records: use `installer/bootstrap.mjs` there. Provider outputs: Claude Code
writes `.claude/**` (no `CLAUDE.md`, no `AGENTS.md`); Codex writes `.codex/**`, `.agents/skills/**`;
Cursor writes `.cursor/**`; Codex and Cursor share the root `AGENTS.md` (section 8).

## 2a. Provider workflows

Prerequisite per provider (not installed by this repository): Claude Code CLI; Codex CLI;
Cursor IDE and/or Cursor Agent CLI (distinct surfaces; the adapter writes project files
usable by both, but capability and enforcement evidence differs).

| Step | Claude Code | Codex | Cursor |
|---|---|---|---|
| 1. Select provider | `--provider claude-code` | `--provider codex` | `--provider cursor` |
| 2. Plan, then apply | `plan --provider <p> --target <dir>`, then `apply --provider <p> --target <dir>` | same | same |
| 3. Open in target | `cd <dir>`, then launch the installed Claude Code CLI | `cd <dir>`, then launch the installed Codex CLI | `cd <dir>`, then open the folder in the Cursor IDE or launch the Cursor Agent CLI using its installed launcher |
| 4. First SDD record | Ask it to write the first specification / project record per [sdd.md](sdd.md), choosing Full, Lightweight or Hotfix | same | same |

If the exact launch invocation of a provider is not known, use that provider's installed
launcher. Asking for a specification first is guidance, not enforcement: the adapter does not
execute SDD, does not install Spec Kit, and enforcement stays **UNVERIFIED**. Do not request
implementation before the SDD gates pass.

## 3. Transaction model

Every mutating command follows the same order, and any failure before step 5 performs **zero writes**:

1. Verify the source (section 4).
2. Resolve the target safely (real directory, no symlinks, not `/`, not the home root, not a user-level provider directory, not this repository).
3. Read all state: provider manifests, `.dac/standard.json`, `.dac/shared.json`.
4. Plan every provider with its `createInstaller` planner plus the shared artifact and records, as one combined, conflict-checked action list. Any conflict aborts with `CONFLICT` and no writes.
5. Re-verify the source (same `HEAD` and tree, still clean), then execute all actions in **one journal**. Each path is re-checked against its planned state right before it is touched. A fault (or a target change) rolls everything back, including directories created or pruned.

Limitation: the journal lives in the process. A hard kill (SIGKILL, power loss) mid-write can leave a partial state; `verify` will report it as drift. Concurrent writers to the same target are not locked out, only detected per path.

## 4. Source requirements and per-project record

The standard source (this checkout) must be the root of a valid Git repository, with a clean
working tree (tracked, staged and untracked changes; ignored files in generator inputs;
`assume-unchanged`/`skip-worktree` flags all count as dirty) and a verifiable full 40-hex `HEAD`
commit. Otherwise `plan`, `apply`, `update` and `uninstall` fail closed (`SOURCE_NOT_GIT`,
`SOURCE_DIRTY`, `SOURCE_UNVERIFIABLE`) with zero writes. No synthetic or shortened commit is ever recorded. `HEAD` and tree are rechecked
immediately before the first write (`SOURCE_CHANGED`); since the tree is clean at both ends, the
generated content is the content of that commit. Limitation: a change that is made and reverted
entirely between the two checks is not detectable.

`.dac/standard.json` (canonical JSON, no absolute paths):

```json
{
  "schema": 1,
  "standard_version": "0.1.0-dev",
  "standard_commit": "<40-hex git commit of this repository>",
  "providers": { "codex": { "adapter_version": "0.1.0", "context7": false, "optional_agents": [] } }
}
```

Records are validated strictly: unknown keys, non-canonical bytes, bad hashes, providers that
disagree with the provider manifests, or shared owners that disagree with them are drift.
Limitation: the records are integrity-checked for shape and consistency, not signed; someone who
edits a record and keeps it self-consistent is not detected.

## 5. Existing project behavior

Preflight inspects every planned path before any write. Rules for `AGENTS.md`, `.claude/`, `.codex/`,
`.cursor/`, `.agents/`, `.dac/` and whole-file configs (`settings.json`, `.mcp.json`, `config.toml`):

- Path missing: create.
- Path exists, byte-identical: unchanged.
- Path exists, not managed by us (or modified since install): **CONFLICT**; the whole run performs **zero writes**.
- No silent merge and no silent overwrite, ever. Whole-file configs are owned entirely or not at all.
- Symlinks (target or any path component) and paths escaping the target are rejected.
- Unrelated files and changes in the target are never touched and do not cause conflicts.
- Only unknown or drifted **managed** paths are rejected.
- `CLAUDE.md` is not generated.

## 6. Update, rollback and uninstall policies

- Update is explicit and applies only to files whose on-disk hash still matches the manifest or ledger.
- Rollback: any fault restores the pre-run state from the single journal across providers, the ledger and records.
- Multi-provider `apply` is atomic across all selected providers (one plan, one conflict check, one journal); it is not applied sequentially.
- Uninstall removes only unmodified managed files; drift is a conflict, not a partial removal.

## 7. Distribution on a new Mac

Clone, ensure a clean checkout, then run the commands in section 2. Nothing is installed globally.

## 8. Shared `AGENTS.md` (Codex and Cursor)

Codex and Cursor use one provider-neutral `AGENTS.md`, rendered identically (no provider name,
generic `.<provider>/dac/` references) by `neutralAgentsMd()`. Their provider manifests declare
`"shared_paths": ["AGENTS.md"]` and do **not** list the file. Ownership is in `.dac/shared.json`:

```json
{ "schema": 1, "files": [ { "path": "AGENTS.md", "sha256": "<hex>", "owners": ["codex", "cursor"] } ] }
```

- apply: creates the file with one owner; a second provider **adds** ownership without rewriting it. Either order, or both in one call, gives identical bytes.
- update: rewrites only if the on-disk hash matches the ledger; all owners receive the same new content in the same transaction.
- uninstall: removes the provider from `owners`; the file is kept while an owner remains. The file is deleted only after the final owner is removed **and** its hash matches the ledger; a modified file blocks the removal (CONFLICT, zero writes).
- migration: a legacy provider manifest that lists a provider-specific `AGENTS.md` migrates on `apply` or `update` only if the file is unmodified against that manifest **and** byte-identical to what this standard's legacy generator produces; otherwise CONFLICT with zero writes.
- A user-owned `AGENTS.md` is a conflict; it is never merged.

## 9. macOS distribution gate

- Static Ubuntu CI: schema validation, generation, installer tests. It cannot prove provider CLIs run on macOS.
- Real macOS gate: `--version`/`--help` probes of provider CLIs in an OS sandbox, never authenticating or calling a model. A sandbox refusal is reported as unverified. This gate is not run by the bootstrap and was not part of Phase 2I-B.
- Authenticated enforcement (whether providers honor read-only/deny settings) remains **UNVERIFIED**. Distribution must not claim it.

## 10. Acceptance criteria and test coverage

Covered by `tests/project-bootstrap.test.mjs`: clean/dirty/non-Git/unverifiable/changed-`HEAD`
sources; initial install; idempotence; unmanaged conflicts and managed drift with zero writes;
update between versions; injected-fault rollback for apply, update and uninstall; uninstall of one
provider; shared `AGENTS.md` in both orders with final removal; legacy migration; symlink and
traversal rejection; unrelated target changes preserved; no-write `plan`/`verify`; Context7 off by
default; no machine paths or OpenClaw references; no Spec Kit install.

## 11. Known limitations

- Authenticated provider enforcement is UNVERIFIED; the generated files are declarative.
- In-process journal only (section 3); no cross-process locking.
- Records are not cryptographically signed (section 4).
- `apply` does not downgrade silently: a different recorded commit requires `update`, which also allows moving to an older commit. Ancestry of commits is not checked.
- Cursor IDE vs Agent CLI behavior differs; enforcement is unverified for both.
- Provider native support for `AGENTS.md` may change.
