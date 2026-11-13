# Spec-Driven Development (SDD)

A provider-neutral, portable SDD methodology inspired by
[GitHub Spec Kit](https://github.com/github/spec-kit) (MIT, Copyright GitHub,
Inc.). This repository defines the methodology as data and validates it. It does
**not** install, execute or copy Spec Kit, and it makes no claim that any
provider or tool supports it. Phase state: see the
[README](../README.md#current-status-phase-2e).

SDD content lives in `standards/sdd/` and `standards/schemas/sdd-*.schema.json`,
deliberately outside agent and skill files (skills must not reference Spec Kit;
existing checks enforce that). Agent manifests are unchanged.

## Files

| File | Kind | Purpose |
|---|---|---|
| `standards/sdd/sdd-workflow.json` | `sdd-workflow` | phases, modes, gates, artifact contracts, milestone policy |
| `standards/sdd/sdd-agent-map.json` | `sdd-agent-map` | agent to phase/role mapping |
| `standards/sdd/spec-kit-integration.json` | `sdd-integration` | declarative, pinned, non-executable future integration |
| any project record | `sdd-project` | one piece of work: artifacts, approvals, scope, validation |

`installer/lib/sdd.mjs` validates them (wired into `installer/lib/run.mjs`, run
by `npm run validate` and `npm test`). Project records are validated against the
workflow and agent map, which must be in the validated set:
`node installer/validate.mjs standards/sdd standards/manifests/agents <project-dir>`.

## Canonical workflow

Order: `constitution` → `specify` → `clarify` → `plan` → `checklist` → `tasks` →
`analyze` → `implement` → `converge` → `independent-validation`. The last phase
is the local final gate and is added by this repository on top of Spec Kit's
nine.

## Modes

| Mode | Use when | Required | Skippable | Tasks | Traceability |
|---|---|---|---|---|---|
| `full` | new capabilities, cross-cutting or high-risk work, unclear requirements | all ten | none | unlimited | all six links |
| `lightweight` | bounded, well-understood change in a project with a constitution | specify, plan, tasks, implement, independent-validation | the rest | ≤ 10 | four core links |
| `hotfix` | urgent, narrow defect fix | specify, tasks, implement, independent-validation | the rest | ≤ 3 | four core links |

Core links: requirement→criterion, task→requirement, task→criterion,
criterion→evidence. Full adds decision→requirement and risk→task.

**Hotfix** never waives approval or independent validation, and cannot cover
`migration` or `production-schema` changes; such work must use Full or
Lightweight with the gates below. A skipped phase needs a recorded reason.

## Gates

Every mode applies every gate. Gates marked † need a granted approval by a human
(`approver_type` is always `human`; agents cannot approve).

| Gate | Blocks | Key conditions |
|---|---|---|
| `pre-implementation` † | the implement phase and any file change | requirements complete, no open questions, tasks have criteria, traceability complete, mode's required earlier phases completed, scope confined |
| `pre-migration` † | database or data migrations | pre-implementation passed, rollback plan (a risk with mitigation linked to the task) |
| `pre-production-mutation` † | production data, schema or configuration changes | same as migration |
| `pre-deployment` † | deployment or release | pre-implementation passed, independent PASS |
| `pass` | recording PASS | independent validator, useful evidence, every criterion covered, every task done |

Task change types map to gates when a task leaves `planned`: `migration` →
pre-migration; `production-schema` → pre-migration and pre-production-mutation;
`production-mutation` → pre-production-mutation; `deployment` → pre-deployment.
Planning such a task needs no approval; starting it does.

PASS requires: evidence with a meaningful description (placeholders such as
`ok` or `n/a` do not count; same rule as result validation), every acceptance
criterion covered by a useful evidence item, a validator mapped as
`independent-validator` that owns no task and is not an implementer. This is a
structural check; it cannot prove the evidence is truthful.

## Artifact contracts

| Artifact | Required fields | Produced in |
|---|---|---|
| requirements | id, statement, acceptance criteria | specify |
| acceptance criteria | id, requirement, statement, verification | specify |
| technical decisions | id, statement, rationale, requirements | plan |
| tasks | id, title, owner, requirements, acceptance criteria | tasks |
| risks | id, description, severity, mitigation | plan |
| validation evidence | description, criteria | independent-validation |
| traceability | derived from the links above | analyze |

## Agent mapping

| Agent | Role | Phases |
|---|---|---|
| repo-analyst | analyst | constitution, clarify, analyze |
| technical-planner | planner | specify, plan, checklist, tasks, analyze |
| prompt-engineer | specifier | specify, clarify |
| site-analyst | analyst | specify, clarify |
| frontend-expert, backend-expert, kmp-expert | implementer | implement, converge |
| e2e-tester | implementer | checklist, implement, converge |
| code-reviewer | independent-validator | independent-validation only |

`code-reviewer` is read-only, independent of every mapped implementer (checked
against its manifest) and never an implementer. Implementers may not validate
their own work. Agents not in the map (for example the optional
`payment-integration`) cannot own SDD tasks until mapped. The map is checked
against the agent manifests' `function`, `read_only` and `independent_of`.

## Scope and milestones

A project declares `allowed_paths` / `prohibited_paths`. Every task path and
every changed file must be inside scope, relative and without `..`, and every
changed file must be covered by a task path.

Milestones are a pre-existing project convention. SDD references them
additively and read-only through the optional `milestone_ref` (existence is
checked with `lstat`; content is never read or written). A milestone path must
not appear in task paths, changed files or allowed scope. The tests prove the
milestone fixtures stay byte-identical.

## Spec Kit integration (declarative only)

`spec-kit-integration.json` pins release `v1.4.0` (published 2026-11-10, tag
object `14ddec8cb22db2a3b50e5ae6861b31053f132bfa`, commit
`0019fa14d12f45edabc2cc3176c9168a68bd0f97`), license MIT, with
`status: not-installed`, `test_status: untested` and
`execution_allowed_in_this_phase: false`. The validator rejects any other pin,
floating refs, automatic install, `--force` by default, missing backup, conflict
detection or rollback verification, and unsafe managed paths. The pin and URLs
are recorded evidence, not checked at run time.

The managed paths (`.specify/`, `specs/`) are **provisional and unverified**:
confirm them, and any integration-specific agent directories, against the
pinned release before the first approved install. A future installer must be an
adapter (`uv-tool`); the manifest contains no executable steps. Adoption
procedure: [sdd-adoption.md](sdd-adoption.md).
