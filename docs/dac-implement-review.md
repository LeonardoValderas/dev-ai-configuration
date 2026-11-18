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
  ids are rejected), `validation_commands` (single-line strings, shown and bound at authorization; dac itself never runs
  them), `needs_network` (default false).

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
`outcome.json`, `reviews/`. Records are written once (exclusive create) and never deleted by dac. Run outcomes:
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
and re-audits the worktree: its content hash must equal the one recorded. It then launches a **separate** read-only
`code-reviewer` runner (role `review`, sandbox `read-only`, no network, no MCP, a different identity from the implementer) with
the exact diff and hashes. The result must satisfy `result.schema.json` with `files_changed: []`. After the review the content,
the Git metadata and the original project are checked again: if anything moved, the verdict is `INVALIDATED`. The record
(`reviews/<id>.json`) binds `audit_hash`, `diff_sha256` and `result_tree`. Verdicts: `PASS`, `FAIL`, `BLOCKED`,
`INVALID_RESULT`, `INVALIDATED`; only `PASS` exits 0. The implementer cannot approve its own work: an implementation runner,
a runner with the implementer's identity, or an unsafe review profile is refused. Review never cleans up, commits or publishes;
integrating the branch is your decision.

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
   `approval_policy="on-request"` for implementation (`"never"` for review), `mcp_servers={}`, `network_access`, `--output-last-message`); `dac implement` shows the exact
   argv. If a flag is rejected the run fails closed with `RUNNER` and evidence is kept; adjust the profile in
   `adapters/shared/sdd-run/runners.mjs` and re-run (a changed profile changes the authorization digest).
2. That Codex honors the task contract over the installed read-only `AGENTS.md` / `.codex` instructions in the worktree.
3. That the sandbox really confines writes to the worktree (the audit will report original-project changes either way).
4. That Codex returns the final JSON result, and that the reviewer runs with the read-only profile.
5. That the audit does not produce false positives on a normal scaffold (line-ending filters, formatter output, lockfiles).

Afterwards inspect `~/.dac-runs/…/<run>/` and the branch `dac/<project>/<task>/<run>`; commit/merge it yourself, or delete the
worktree and branch. dac does neither.
