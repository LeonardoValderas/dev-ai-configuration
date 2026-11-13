# Portable agent catalog

`standards/manifests/agents/agent-catalog.json` (`kind: agent-catalog`) lists the
12 original agents with an explicit classification. The non-redundant agents
have a portable definition next to it (`<id>.json` + `<id>.md`): 10 manifests
and 10 instruction files.

| Classification | Count | Agents | Manifest |
|---|---|---|---|
| primary | 8 | `repo-analyst`, `technical-planner`, `prompt-engineer`, `site-analyst`, `frontend-expert`, `backend-expert`, `kmp-expert`, `e2e-tester` | yes |
| optional | 2 | `code-reviewer`, `payment-integration` | yes |
| redundant | 2 | `backend-architect` → `backend-expert`, `frontend-developer` → `frontend-expert` | no (`superseded_by` names the primary) |

The inventory is exactly these 12 names. The two redundant agents have no
portable manifest because their guidance is covered by the primary agent named
in `superseded_by`.

## Origin of the content

Names, responsibilities and classification were taken from the original agent
definitions and rewritten portably (no machine paths, no tool/provider-specific
fields, no runtime dependency). Every entry records `provenance:
original-agent-file`. The original definitions are not part of this repository
and are not modified by it.

## Manifest contract

Agents extend the existing agent schema with optional fields (older manifests
stay valid); catalog-linked agents must declare all of them:

- `function`: `implementer`, `reviewer`, `validator` or `advisor`.
  Here: `repo-analyst`, `technical-planner`, `prompt-engineer`, `site-analyst`
  are advisors (read-only); `frontend-expert`, `backend-expert`, `kmp-expert`,
  `e2e-tester`, `payment-integration` are implementers; `code-reviewer` is the
  reviewer.
- `read_only`: required `true` for every non-implementer.
- `contracts`: `{task: "task-contract", result: "result"}`, the common task and
  result contracts in `standards/schemas/`.
- `activation`: when to use the agent. `limits.max_files_changed`: hard cap
  (0 for read-only agents).
- `independent_of`: for reviewers and validators, the implementers whose work
  they check; an agent can never review itself.
- `permissions`: minimum explicit tools, commands and scoped `writable_paths`;
  `production_access` is `none`; `bypassPermissions` is rejected.

### code-reviewer

`code-reviewer` is strictly read-only: tools `Read`, `Grep`, `Glob`; shell
limited to `git diff|status|log|show`; `permission_mode: plan`; no
`writable_paths`; `max_files_changed: 0`. It cannot run `npm test` or
`npm run validate` (only a `validator` may), so it never executes validation.
It is independent of the implementers (`backend-expert`, `frontend-expert`,
`kmp-expert`, `e2e-tester`, `payment-integration`) and may not review its own
work. Validation stays an independent step: no implementer or reviewer
vouches for its own result.

Tool names (`Read`, `Grep`, `Edit`, ...) are logical capability names. Claude
Code, Codex and Cursor are not assumed equivalent: mapping, and whether a tool
can enforce a given restriction, is the job of each (future) adapter.

## Validator rules

`AGENT_POLICY` (rules: `read-only-violation`, `read-only-required`,
`independence`, `limits`, `missing-portable-field`, `production-access`,
`catalog-count`, `classification`, `orphan-manifest`, `redundant-has-manifest`,
`code-reviewer-read-only`), `RUNTIME_COUPLING` (any OpenClaw reference in agent
manifests, the catalog or agent instructions), plus the existing
`MISSING_REFERENCE`, `DANGEROUS_PERMISSION`, `ABSOLUTE_PATH`. The catalog works
with no OpenClaw runtime; the validator needs no network or credentials.

## CI

`.github/workflows/pr-validation.yml` runs on `pull_request` to `main` only,
with `contents: read`, no secrets, no deploy/publish, Node 20, and every action
pinned to a full commit SHA (`actions/checkout`
`11bd71901bbe5b1630ceea73d27597364c9af683`, `actions/setup-node`
`49933ea5288caeca8642d1e84afbd3f7d6820020`). There is no lockfile or
dependency, so there is no install step; it runs `npm test` and
`npm run validate`.
