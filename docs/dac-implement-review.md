# `dac implement` and `dac review` (Increment B)

Both commands extend the existing DAC; they add no orchestrator, daemon or provider SDK. They reuse the bootstrap record
(`.dac/standard.json`), the SDD Artifact Writer (receipts, hashes, locks, drift, rollback), the handoff, the trusted-terminal
confirmation (`openTrustedTerminal`), the task/result contracts, `checkProject()` and the read-only `code-reviewer`.
Code: `adapters/shared/sdd-run/` (`context`, `git`, `audit`, `runners`, `implement`, `review`, `store`). Tests: `tests/dac-implement-*.test.mjs`.

> **Status.** Everything below is verified locally with **simulated** implementation and review runners. The production Codex
> runner exists, but its command-line profile has **never been run against a real Codex binary** (this repository never
> probes providers). Real Codex behavior is pending the second-Mac pilot at the end of this page.

## 1. Plan and Tasks are persisted by the Writer (`project.json`)

The SDD Artifact Writer accepts a third artifact, `project`, stored as `.sdd/artifacts/<project-id>/project.json`. It is the
existing `sdd-project.schema.json` record, validated by `checkProject()` (traceability, scope, owners, gates). It goes through
the same plan/apply flow, trusted-terminal approval, receipt chain, hashes, lock, drift detection and rollback, and through the
same handoff envelope (`project` is a new optional key next to `constitution` and `specify`); there is no new input file.

- `id` is the **SDD project id**; it is unrelated to `package_name` in `.dac/project.json`.
- It is **documentation only**. The writer rejects a `project` that records approvals, changed files, started tasks, a
  completed `implement`/`converge`/`independent-validation` phase or a non-`NOT-RUN` validation. **Persisting it authorizes
  nothing**; `dac implement` has its own gate.
- No derived Markdown, no `milestone_ref`.
- Additive schema fields on a task (all optional, so existing records stay valid): `depends_on` (task ids; cycles and unknown
  ids are rejected), `validation_commands` (single-line strings, shown and bound at authorization; `dac implement` never runs
  them, `dac review` runs exactly this authorized list as independent validation, see §5), `needs_network` (default false).

## 2. `dac implement <task-id> [--project <id>] [--preserve-dirty] [--model <model>]`

**Model selection (`--model`, also on `dac review`).** `dac implement t01 --model <supported-model>` passes exactly that value to
Codex as `codex exec --model <supported-model> ...`. Which models work is **account-specific** (a model available to one
Codex/ChatGPT account may be unsupported for another, and a second machine can inherit a different model from its own Codex
configuration), so **you choose it; dac has no catalog, no default, no normalization and no fallback**. Without `--model` no
`--model` argument is passed and Codex uses the model from its own configuration; the preview says so
(`model: inherited from the Codex configuration`). The value must be a single non-empty word of at most 200 characters, without
control characters, whitespace at the edges or a leading `-`. The model selection is part of the runner profile and therefore of the
authorization digest (changing or adding/removing `--model` requires a new approval) and is stored in `authorization.json`,
`run.json` and the review record. If Codex rejects the model, the run ends `RUNNER_FAILED` with the evidence kept, and the
output shows a short, redacted excerpt of Codex's stderr plus the transcript path.

1. **Project.** The nearest ancestor with `.dac/standard.json` (as for every command). The SDD project is the only persisted
   one, or `--project <id>` when several exist (ambiguity is an error, never a guess).
2. **Verified context** (read-only, before any prompt): bootstrap integrity OK; `dac sdd verify` OK (receipt chain, no drift,
   no lock); `constitution.json`, `specify.json` and `project.json` present, valid and consistent with each other; all
   mode-required phases before `implement` completed; no open questions; the task exists, is `planned`, is `code`/`test`/
   `docs`/`config` (migrations, production changes and deployments need gates dac does not own), has requirements, criteria
   and plain paths (no globs, nothing protected or prohibited). Anything else stops with a precise reason.
3. **Dependencies.** A `depends_on` task counts only when a run of it passed audit **and** an independent review (PASS), **and**
   its exact reviewed content is in the project's current `HEAD` (you integrated it, by any means; checked by content hash).
4. **Git.**
   - *Born repository:* the base is `HEAD`. A dirty tree is refused unless you pass `--preserve-dirty`; then every change stays
     byte-identical and is **not** part of the worktree (it starts from `HEAD`). dac never stashes, resets, cleans or hides.
   - *Unborn repository:* the authorization includes an **explicit reviewed baseline**: the exact list of files (tracked +
     untracked, honoring `.gitignore`) that will form a first commit, plus every excluded path with its reason (DAC/provider
     directories, sensitive names such as `.env`/`*.pem`, symlinks, oversized files, staged content that differs from the working
     tree). It is committed from a temporary index (`git add .` is never used; staged-but-excluded files stay staged) only after
     your approval, and only if the files are still byte-identical to what you reviewed.
5. **Trusted-terminal authorization.** dac shows the task, objective, target, base, working-tree policy, allowed/prohibited/
   protected paths, the "exact path only" rules, ceilings, validation commands, network need, dependencies, runner profile,
   artifact and receipt hashes, prompt/context hash and one authorization digest, then asks on `/dev/tty` for
   `approve <digest12> <nonce8>`. No flag, environment variable, stdin, file or model output can approve. The authorization binds
   the exact target, artifact hashes, task, base, worktree location (`<state>/<task>/` and branch prefix
   `dac/<project>/<task>/`; approval binds this **parent and branch prefix**, not an exact worktree: the run id and the exact
   worktree path/branch are generated only **after** approval), allowed/prohibited paths, validation commands, network, runner profile and prompt/context hash.
   A still-valid approval of the **exact same digest** (reuse window is the canonical Writer `TTL_SECONDS` = 600 s; the stored record binds an explicit `expires_at` = `approved_at` + 600 s inside its `record_digest`; never reused at or after expiry; integrity-checked) is reused without a prompt; any material drift
   (artifacts, base commit, scope, prompt, profile) changes the digest and asks again. Drift between approval and launch aborts
   before anything is created. Unborn repositories always ask.
6. **Isolation.** dac creates the branch `dac/<project>/<task>/<run>` and a worktree under the run directory automatically
   (`git worktree add`, hooks and filters off). Nobody creates worktrees, task JSON, profiles or audit scripts by hand.
7. **Context for the run** (per run, under the run directory; installed read-only configs are never edited): the task contract
   (`task-contract.schema.json`), a deterministic prompt (contract, owner-agent instructions, result format) and the document
   hashes. The prompt states that the task contract supersedes read-only/analysis-only repository instruction files.
8. **Runner.** Launched only through an injectable runner with an explicit profile: sandbox `workspace-write`, approval
   `on-request`, no MCP, network only when the persisted task declared it **and** you approved it, bypass `false`. `assertSafeProfile`
   enforces this for any runner, including injected ones (`danger-full-access`, `--yolo`, `--dangerously-bypass…`, wrong role or
   an unauthorized network setting are refused before anything is created). The independent review runner is the opposite
   profile: sandbox `read-only`, approval `never`, no network, no MCP.
9. **Blocking audit** (always, also after a runner failure; see §4). **Evidence** is retained and nothing is cleaned,
   committed (except the reviewed unborn baseline), merged or published.

## 3. Where things live

`~/.dac-runs/<project>-<hash>/<sdd-project>/<task>/<run>/` (override: `DAC_RUNS_DIR`; must be outside the project):
`authorization.json`, `context/`, `worktree/`, `run.json` (pre-run fingerprints), `result.json`, `audit.json`, `diff.patch`,
`outcome.json`, `reviews/`, `validation/attempt-<n>/` (independent validation, §5). Records are written once (exclusive create) and never deleted by dac. Run outcomes:
`READY_FOR_REVIEW`, `AUDIT_BLOCKED`, `RUNNER_FAILED`, `NOT_REVIEWABLE`. Remove a run yourself with
`git worktree remove` and `git branch -D` when you no longer need it.

## 4. The audit (blocking, comprehensive)

A Git worktree is **not** a path-level sandbox, so the audit never trusts `git status` or the provider's report. It walks the
whole worktree (tracked, untracked **and ignored**) and compares each entry with the authorized base tree by content hash,
type and mode, then evaluates:

| Check | Blocks when |
|---|---|
| Paths | outside the exact allowed paths, in `prohibited_paths`, or protected at any depth (`.git`, `.dac`, `.sdd`, `.codex`, `.claude`, `.cursor`, `.agents`, `.specify`, `AGENTS.md`, `CLAUDE.md`, `.gitmodules`, `.gitattributes`) |
| Exact-path-only | manifests, lockfiles, CI/env files (`package.json`, `go.mod`, `.github/`, `.env*`, …), deletions, mode changes, new executables are touched without their **exact path** in the task (this is what permits first-task root scaffolding) |
| Types | symlinks (except an unchanged tracked one), hard links, special files, setuid/setgid/sticky, nested `.git`, content inside a submodule path, unsafe names |
| Ignored files | any ignored addition (it would be invisible in a diff) |
| Renames/copies/deletes | a rename is a delete + add: the delete needs its exact path |
| Ceilings | more than 200 changed files, 2 MiB per file, 20 MiB total, 200 000 walk entries |
| Git state | `HEAD`, the run branch, any ref/tag/stash, remotes, config, hooks, `info/`, alternates or the worktree link file changed |
| Original project | its `HEAD`, index, every non-ignored change (with content hash), ignored top-level names, or any DAC/provider directory changed during the run |

If it passes, dac builds the **exact reviewable content**: a tree object (via a temporary index) and `diff.patch`; the
`audit_hash` covers base, branch, every change with its sha256, the result tree and the diff hash. If it blocks, the worktree
and evidence stay as they are and the run is never reviewable. Limits: the original-project check compares ignored paths by name
only; nothing outside the project and the Git metadata (for example your home directory) can be audited, which is why the
runner profile (a real sandbox) is the primary containment and the audit is the independent check; `.gitattributes`
end-of-line/filter rules in a repository can make unchanged files look modified (fail-closed).

## 5. `dac review <task-id> [--project <id>] [--run <run-id>] [--model <model>]`

`--model` works as for `dac implement` (`dac review t01 --model <supported-model>`; model availability is account-specific, no
fallback). Review has no pre-implementation approval, so the selected or inherited model is printed when the review starts and
recorded in the review record (`reviewer.model`, `reviewer.profile`).

Only a `READY_FOR_REVIEW` run can be reviewed. Several candidates require `--run` (ambiguity is an error that lists them). dac
verifies the evidence (`run.json`, `audit.json`, `diff.patch` hashes), that the SDD documents and task contract are unchanged,
and re-audits the worktree: its content hash must equal the one recorded. It then runs the **independent validation** (below)
and only if that passes launches a **separate** read-only
`code-reviewer` runner (role `review`, sandbox `read-only`, no network, no MCP, a different identity from the implementer) with
the exact diff and hashes. The result must satisfy `result.schema.json` with `files_changed: []`. After the review the content,
the Git metadata and the original project are checked again: if anything moved, the verdict is `INVALIDATED`. The record
(`reviews/<id>.json`) binds `audit_hash`, `diff_sha256` and `result_tree`. Verdicts: `PASS`, `FAIL`, `BLOCKED`,
`INVALID_RESULT`, `INVALIDATED`; only `PASS` exits 0. The implementer cannot approve its own work: an implementation runner,
a runner with the implementer's identity, or an unsafe review profile is refused. Review never cleans up, commits or publishes;
integrating the branch is your decision.

### Independent validation evidence (no new command; part of `dac review`)

Before the reviewer starts, dac itself executes **exactly** the task's authorized `validation_commands` (the canonical list the
human approved; for example `npm test` and `npm run build`) through a dedicated, injectable *validation runner* (role
`validate`, a different identity than the implementer and the reviewer; `assertSafeValidationProfile`). Reviewer output is never
executed. Commands run as exact argv wrapped by macOS `sandbox-exec` (`shell: false`, hermetic environment without provider keys, `CI=1`, cwd = a
disposable copy of the audited tree, network and out-of-workspace writes denied, see "Isolation" below); a command that needs shell syntax (quoting, `&&`, pipes, redirects, env assignments, expansion) is refused,
not interpreted. The command set in `authorization.json` must equal the task contract's; any difference is an unauthorized
command set.

Binding: the worktree/Git/original-project/evidence state is re-checked **before every command and after all of them**
(content hash, Git metadata, original project, approval/other-run evidence, and the sha256 of `run.json`, `audit.json`,
`diff.patch`, `authorization.json`, `outcome.json`). A failed command (non-zero exit, signal, spawn error), any drift,
missing or inconsistent runner evidence, or an unauthorized command **blocks** the review: the verdict is `BLOCKED`,
`reviewer_invoked: false`, the reviewer is never launched, and the review record points at the validation record. A task with no
`validation_commands` runs nothing; the prompt then says that no independent validation evidence exists.

Records: `validation/attempt-<n>/record.json` plus `cmd-<i>.stdout.txt` / `.stderr.txt` (raw, up to 8 MiB per stream, with
truncation flag and sha256), all exclusive-create under the run directory outside the project; attempts are numbered, so a
retry adds `attempt-<n+1>` and a new `reviews/<id>.json` and changes nothing else (run, authorization, audit, diff, worktree,
standard commit, earlier reviews and attempts stay byte-identical). Each record binds `audit_hash`, `content_hash`,
`result_tree`, `diff_sha256`, `base_commit`, the command and argv, exact cwd, start/finish timestamps, exit code/signal,
stream hashes and the runner identity/profile.

The reviewer prompt receives a bounded, redacted canonical summary (tail excerpts of at most 20 lines / 2 KiB per stream plus
hashes and the record path) in four **separately labelled** classes: (1) implementation evidence, *not independent* (the
implementer's result, claimed evidence, transcript hashes); (2) independent validation evidence (executed by dac); (3) declared
controls/profile (declarations, not proof of enforcement); (4) observed actions/audit (what the audit inspected and what it
cannot observe). For constraints such as "no network / no `npm install` / no Git writes" the prompt states what the profile,
audit and transcripts prove and what stays **unverified**; "not observed" is never presented as "did not occur", and the criteria
are not changed.

**Disposable validation workspace.** Commands never run in the audited worktree. After the binding check, dac copies the
audited result tree into `validation/attempt-<n>/workspace/` (regular files and their directories only; modes 0644/0755; no
`.git`, no symlinks, no hardlinks, no special files, no path escape; every file is re-read without following symlinks and its
blob id re-verified while copying). Binding: `manifestOf` (shared with the audit, `audit.mjs`) recomputes the Git tree id of the
source worktree and of the copy in pure JS; both must equal `audit.result_tree` and the two manifests must be identical, else
the attempt is `BLOCKED` before any command runs (e.g. a source tree with a symlink or a submodule path cannot be copied and
fails closed). The pre-validation manifest is stored as `pre-manifest.json` (sha256 in the record). `record.json` shows
`source_worktree`, `validation_cwd` (the workspace) and the binding hashes.

Validation byproducts: after each command dac inventories the workspace (type/mode/sha256, symlinks included, never
followed) and records what was **generated, modified or deleted** relative to the previous state in `cmd-<i>.outputs.json`,
plus the cumulative `outputs.json`. These are validation byproducts inside the copy, **not product changes**; they cannot
affect the audited worktree, `audit.result_tree` or any hash of the run. The reviewer sees counts and a bounded sample, labelled
as byproducts.

Cleanup: the workspace is removed only after `record.json` and the manifests/outputs were written, and only the attempt's
own `workspace` directory (never another attempt, never the worktree). `cleanup.json` records `removed` or `retained` with the
reason; if recording throws before the record exists, or removal fails/is uncertain, the workspace is **retained** and
reported. Manifests, outputs, stdout/stderr and records are never removed.

**Isolation (preventive controls).** The production validation runner spawns every authorized command as
`/usr/bin/sandbox-exec -D WORKSPACE=<canonical real workspace path> -p <profile> <original executable> <original args…>` with
`shell: false`; the logical argv in the evidence stays the authorized argv. The profile is
`(allow default) (deny network*) (deny file-write*) (allow file-write* (subpath WORKSPACE) (literal /dev/null))`: **all network is
denied** and **writes are denied everywhere except under the disposable workspace** (not the audited worktree, run evidence,
repository, HOME or general temp; `/dev/null` is the only extra sink). Reads are not restricted. The runner profile and the
validation record carry the isolation identity (`macos-sandbox-exec`, profile id and sha256, the profile text).
The environment is hermetic: only `PATH`, `LANG`, `LC_ALL`, `TERM` are inherited, plus `CI=1`; `HOME`, `TMPDIR` and the npm cache
are private directories inside the workspace (`.dac-validation/home|tmp|npm-cache`, user/global npm config pointed at nonexistent
files). Provider/API keys, npm tokens and `NODE_OPTIONS` are not inherited. Those directories are **DAC validation infrastructure**,
reported separately (`dac_infrastructure`) from command byproducts and never counted as product output.
**Non-macOS (including Linux) is BLOCKED** until a supported isolator exists, and so is a missing or unusable `sandbox-exec`: dac
never falls back to a direct spawn.

**Detective controls.** The audit and before/after fingerprints (above) still detect drift of the audited worktree, Git metadata,
original project and evidence, and block the review; dac does not undo it. Neither control proves that something did **not**
happen, and neither claims task path/glob prevention: the sandbox is workspace-wide, not per task `paths`. Package installation or
network use during the *implementation* run remain unverifiable and are reported as such.
Tests: repository tests use simulated validation and review runners and an injected spawn; `tests/dac-validation-sandbox-macos.test.mjs`
runs real synthetic commands (not project scripts) under `sandbox-exec` on macOS (inside write allowed, outside write denied,
loopback network denied against a live listener) and is explicitly **skipped** (never passed) where `sandbox-exec` is unavailable.

### npm provisioning and offline validation (React/Vite-like tasks; part of `dac review`, no new command)

Applies only when the audited result has `package.json` dependencies and/or a `package-lock.json` **and** an authorized
validation command starts with `npm`. Projects without npm dependencies, or without an npm validation command, keep the
behaviour described above (no probe, no prompt, no provisioning). Lockfile generation is **never** performed during review:
`package-lock.json` must already be in the audited result (listed by exact path in the task scope).

Strict detection, fail closed: missing/invalid `package.json` or lock; package/lock dependency mismatch; `lockfileVersion` other than 3;
local/`file:`/`link:`/git/URL/alias/`workspace:` dependencies or lock entries (`link`, non-`node_modules` paths, non-https, credentialed or
non-`registry.npmjs.org` `resolved`, missing sha512 `integrity`); `workspaces`; any `.npmrc` or `npm-shrinkwrap.json` in the tree; npm
validation commands other than `npm test` / `npm run <script>` / `npm run-script <script>` (no options before `--`; never install/ci/
rebuild/config/exec). A toolchain that cannot be determined also blocks.

1. **Provisioning (the only network phase).** dac asks for a *dedicated* trusted-terminal approval (`/dev/tty`; the canonical Writer
   `mintAuthorization`/`checkAuthorization`/`effectiveConfirmTimeoutMs`/`confirmationPhrase`/`openTrustedTerminal`, operation `npm-provision`,
   bound to target/project/prior state/standard commit and the identity digest; lifetime is `issued_at` + exactly 600 s and is **never
   extended** by a slow confirmation; exact phrase; never `--yes`, stdin, environment, a record or model text; no TTY, timeout or denial
   blocks). After confirmation, and again immediately before the network phase, the authorization is re-checked with `checkAuthorization`
   against a freshly recomputed exact plan and the current time: expiry or drift blocks with no download. The approval is bound
   to one identity digest: `audit_hash`, `result_tree`, `content_hash`, sha256 of `package.json` and `package-lock.json`, Node/npm
   versions, platform/arch/libc (where available), install policy and flags, the authorized validation commands and the cache identity;
   the prompt shows them. After confirming, the inputs and the Git/project/evidence binding are re-checked; anything that moved blocks
   before any download. Then `npm ci --ignore-scripts --no-audit --no-fund` runs in a disposable workspace (exact `package.json` + lock)
   under a **separate provisioner** (role `provision`, id `dac-npm-provisioner`, distinct from implementer/validator/reviewer) inside macOS
   `sandbox-exec`: writes are denied except that workspace and its private cache; network is enabled for this phase only (not
   host-filtered; the lock is limited to `registry.npmjs.org`). HOME, TMPDIR, cache, user/global npm config are private; no npm config,
   token, provider key, `NODE_OPTIONS`, HOME or user cache is inherited. Before the network phase a preflight *observes* that a write
   inside is allowed and a write outside is denied (`enforcement.level: verified-by-preflight`; an injected runner without preflight is
   `configured-only`, i.e. configuration, not verified enforcement).
2. **Verified cache.** The cache must be a plain file tree (no symlink/hardlink/special file), contain every tarball the lock requires for
   this platform (optional `os`/`cpu`/`libc` packages for other platforms are accounted for, not assumed), and each tarball's bytes must
   hash to the lock's sha512 integrity **in the real npm cacache layout**: `npm_config_cache` is the cache directory and npm keeps its data
   under `<cache>/_cacache/content-v2/sha512/..` and `<cache>/_cacache/index-v5/..` (a cache with `content-v2`/`index-v5` directly under the
   cache directory is rejected). Each required tarball must also have real index metadata (bucket = sha256 of
   `make-fetch-happen:request-cache:<resolved url>`, sha1-valid line whose `key` and `integrity` match the lock), which `npm ci --offline`
   needs to find it. A content manifest (`cache-manifest.json`) and its hash are stored with the approval envelope
   (`approval.json`: the canonical authorization unchanged + an explicit cache-reuse grant, bound by a digest) and the record (`record.json`) under
   `<run>/npm-provision/<identity-digest>/attempt-<n>/` (exclusive create, numbered attempts, outside the project; failures, cancellations
   and drift are recorded too, with stdout/stderr hashes; only the disposable workspace is removed).
3. **Reuse.** A later review of the same run with the identical identity reuses the cache **without a new approval and without network** only if
   an earlier PASS attempt completed under an approval envelope for exactly that identity (canonical authorization shape/600 s TTL/binding valid as of
   its issuance, canonical reuse grant, envelope digest intact) and the cache re-verifies
   (manifest re-walk, recorded hashes, lockfile integrity). Directory names and record files are never trusted alone: tampering,
   missing/extra files, a different identity (e.g. other Node/npm/platform or commands) or a cache planted under another identity's
   directory blocks and is **never silently re-provisioned**. A changed identity is a new identity and needs a new approval. Two things
   are deliberately distinct: the **interactive authorization** (600 s from `issued_at`) gates only *starting* a download and is useless
   after expiry; the **cache-reuse grant** in the envelope (exact `identity_digest`, purpose `offline-validation`, no network, no
   re-provisioning, valid only while the cache re-verifies against the manifest and lock) authorizes consuming the *completed* download
   later without a TTY, even after the authorization expired. It never authorizes re-provisioning or network after expiry; an edited
   envelope or grant is rejected.
4. **Offline validation.** The verified cache is copied (byte-identity proven) into the private writable cache of the existing disposable
   validation workspace, then `npm ci --offline --ignore-scripts --no-audit --no-fund` runs there under the existing network-denied
   sandbox, **before** the already-authorized commands (which are unchanged and still the only commands counted). `record.json` has a
   separate `npm` block: command/cwd/exit/signal/stdout+stderr hashes (`install.stdout.txt`, `install.stderr.txt`), binding before/after,
   cache identity and hashes, and `install.outputs.json` for the install byproducts. A failed install, a changed
   `package.json`/lock in the workspace, a missing `node_modules`, or any drift blocks before the reviewer.
5. `node_modules`, the cache, `dist`/`coverage`/logs are validation infrastructure/byproducts inside the disposable copy; nothing is copied to
   the audited worktree, the project or the diff. Install scripts have **no exception**: packages that declare them (listed in the identity)
   never run them, and a package that needs them makes the offline install fail closed.

Configured vs verified: the sandbox profiles, `--ignore-scripts` and the private environment are configuration; what is *observed* is the
provisioner preflight, the manifest/integrity verification and the binding/hash checks. Network behaviour and script behaviour of npm itself
are not independently observed. Non-macOS (including Linux) stays **BLOCKED**: no probe, no provisioning, no direct spawn.
Tests: `tests/dac-npm-provision.test.mjs` (local deterministic fixtures and injected runners/terminals; no download, no provider) and
`tests/dac-npm-provision-sandbox-macos.test.mjs` (real `sandbox-exec` with synthetic commands and an offline `npm ci` against an empty cache;
explicitly skipped, never passed, where unavailable).

## 6. Second-Mac pilot (DAC commands only; real Codex pending)

Prerequisites: a clean checkout of this repository, Node 20+, Codex installed and logged in by you. Everything below uses
`dac`; you create no worktree, task JSON, profile or script.

```sh
cd /path/to/your-new-or-existing-project         # may be empty / git-init'ed with no commits
node <clone>/bin/dac.mjs init --provider codex   # or: init (interactive)
node <clone>/bin/dac.mjs start                   # custodian, foreground (separate terminal)
# In Codex (read-only SDD agents), produce Constitution, Specify and Plan/Tasks and submit them through the handoff
# (`project` envelope). A task that scaffolds the project lists package.json etc. by exact path in `paths`.
node <clone>/bin/dac.mjs sdd plan  --handoff <ID>
node <clone>/bin/dac.mjs sdd apply --handoff <ID>      # approve on the terminal
node <clone>/bin/dac.mjs sdd verify --project <project-id>
node <clone>/bin/dac.mjs implement <task-id> --model <supported-model>   # review the contract (and the baseline if the repo is unborn), type the phrase
node <clone>/bin/dac.mjs review <task-id> --model <supported-model>      # independent read-only review of the audited run
```

`<supported-model>` is a model your own Codex account supports (account-specific: pick it yourself; the first pilot attempt failed
because the second Mac inherited `gpt-5.5` from its Codex configuration, which the ChatGPT account did not support). Omit
`--model` only if the model inherited from your Codex configuration is supported. dac never substitutes a model.

Worktree-private Git metadata that can hide changes (`info/exclude`, `info/sparse-checkout`, `config.worktree`, hooks,
`commondir`/`gitdir`, and the shared `info/` and `hooks/`) is fingerprinted when the run starts and re-checked by both the
implementation audit and the review re-audit; any change blocks. A tracked symlink replaced by a regular file at the same
path is blocked as a `type-change` violation.

**Dependency injection.** `bin/dac.mjs` exports `main(argv, cwd, io)` for the production CLI, which never accepts or forwards
injected dependencies; the injectable seam (`mainWithDeps`, runners, terminal, clock, state dir) is internal and used only by
tests. A test exercises the production entry path and proves injected runners/terminals are ignored.

What the pilot must establish (these are **not** proven by the local tests):

1. Whether the printed Codex runner profile is accepted by the installed Codex version (`sandbox workspace-write`,
   `approval_policy="on-request"` for implementation (`"never"` for review), `mcp_servers={}`, `network_access`, `--output-schema`, `--output-last-message`); `dac implement` shows the exact
   argv. If a flag is rejected the run fails closed with `RUNNER` and evidence is kept; adjust the profile in
   `adapters/shared/sdd-run/runners.mjs` and re-run (a changed profile changes the authorization digest).
2. That Codex honors the task contract over the installed read-only `AGENTS.md` / `.codex` instructions in the worktree.
3. That the sandbox really confines writes to the worktree (the audit will report original-project changes either way).
4. That Codex returns the final JSON result, and that the reviewer runs with the read-only profile.
5. That Codex accepts the `--output-schema` file. It is derived deterministically from `standards/schemas/result.schema.json`
   (references inlined; optional evidence properties listed as required, which only narrows what the provider may emit) and is
   written next to the transcript as `<role>-output-schema.json`. It is a provider hint, not a second contract: the result is
   still validated against the canonical schema, a missing `schema_version` stays `INVALID_RESULT`, and dac never repairs or
   injects fields.

Retrying a review after `INVALID_RESULT`: the failed review record and the run evidence are immutable and untouched. Re-run
`dac review <task-id> --run <run-id> [--model <model>]` with the corrected dac. It re-verifies `run.json`, `audit.json`,
`diff.patch`, the SDD artifacts (including the installed standard record hash) and the worktree, then writes a *new* review record
beside the failed one; provider files of the retry get a numeric suffix (`review-last-message-2.txt`, ...). If the installed
standard record changed since the run (for example `dac update` in the project to adopt the fixed standard commit) the review is
refused with `DRIFT` by design. Review first, with the corrected dac against the project as it was; the project's recorded
`standard_commit` is not compared with the dac source commit, so no update is needed. Never edit the evidence to get past it.
5. That the audit does not produce false positives on a normal scaffold (line-ending filters, formatter output, lockfiles).

Afterwards inspect `~/.dac-runs/…/<run>/` and the branch `dac/<project>/<task>/<run>`; commit/merge it yourself, or delete the
worktree and branch. dac does neither.

## Criterion evidence matrix (review prompt, section 5)

`dac review` derives, read-only and from evidence that already exists, a matrix `criterion -> needed evidence -> source -> run binding -> status` (`available` = readable now from preserved evidence, `recoverable` = preserved but not verified here, `not-recorded` = never captured). Every item is bound to `run_id`, `base_commit`, `result_tree` and `audit_hash`. Nothing is written, re-run or reinterpreted; run authorization, hashes, `standard_commit` and prior evidence are unchanged.

- **Managed project metadata** is read from the ORIGINAL project's `.dac/project.json` (not `.dac/standard.json`, not the worktree); `package_name` is read from the exact managed shape `{"schema":1,"package_name":<string>}` and never modified. The current project is bound to the run baseline with the fingerprint the run already recorded: if `mainFingerprint(root)` equals `run.pre.main` the file is proven unchanged from the baseline (`baseline-bound`); if it differs the result is `drift` (which component changed is not guessed and the current value is not used); `absent` and `uninspected` (unreadable, not a regular file, no baseline recorded, not the exact shape) are separate outcomes.
- **package.json** is read from Git objects of the exact audited `result_tree` and `base_commit`. The change fact is `absent` (in neither), `uninspected`, `match` (unchanged from baseline) or `changed`. `uninspected` is never a match.
- **ac-package** exposes both the semantic comparison (baseline-bound `package_name` vs audited `package.json` `name`: `match`, `mismatch` or `not-comparable` with the reason: metadata absent/drift/uninspected, package.json absent/unreadable/invalid/no name) and the baseline/change facts (`baseline_status`, `package_json_change`) as separate fields. The row is `available` only when the comparison is determinate and baseline-bound; `not-recorded` when metadata or package.json does not exist; otherwise `recoverable`.
- **Independent validation** is re-read from the preserved record: command list equals the authorized list, cwd, exit code/signal, stdout/stderr hashes (recomputed from the stored files), bound hashes and the tested tree equal to `result_tree`. Without authorized commands there is no validation evidence (not a pass). Absence of a blocker is never inferred as PASS.
- **Scope/network criteria** list separately configured controls (declared), observed actions (what the audit inspected), effectively verified restrictions, and not-recorded evidence (implementer command log, network activity, sandbox enforcement). Missing required historical evidence keeps the criterion UNVERIFIED and the result BLOCKED; criteria are not changed retroactively.
