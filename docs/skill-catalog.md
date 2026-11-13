# Portable skill catalog

`standards/manifests/skills/skill-catalog.json` (`kind: skill-catalog`) inventories
exactly 21 original skills, classifies each one and records its provenance,
license evidence, dependencies, minimum permissions, risks and conflicts. The
original skills are read-only inputs and are never modified; `origin.sha256` is
the digest of each original `SKILL.md` so that fact can be re-verified.

| Classification | Count | Skills | Portable manifest |
|---|---|---|---|
| CORE | 2 | `supabase-postgres-best-practices`, `frontend-design` | yes |
| OPTIONAL | 0 | none | n/a |
| QUARANTINED | 18 | `apify`, `brandkit`, `design-taste-frontend`, `find-skills`, `firecrawl`, `full-output-enforcement`, `gpt-taste`, `high-end-visual-design`, `image-to-code`, `imagegen-frontend-mobile`, `imagegen-frontend-web`, `industrial-brutalist-ui`, `micro-saas-launcher`, `minimalist-ui`, `redesign-existing-projects`, `senior-secops`, `stitch-design-taste`, `stripe-integration` | no |
| DEPRECATED | 1 | `design-taste-frontend-v1` → `design-taste-frontend` | no |

## Third-party provenance and license (Supabase)

`supabase-postgres-best-practices` has **verified official provenance**
(`verified-upstream`), recorded as evidence in the catalog entry and manifest:

| Item | Value |
|---|---|
| Upstream repository | https://github.com/supabase/agent-skills |
| Pinned source commit | `f421451c7956d9a79b8257ccc24a7ab6d16037e2` (historical; current `main` may be newer) |
| Skill path | `skills/supabase-postgres-best-practices` |
| License | MIT (SPDX `MIT`), Copyright (c) 2026 Supabase |
| License URL | https://github.com/supabase/agent-skills/blob/main/LICENSE |
| Shipped license text | `standards/manifests/skills/licenses/supabase-postgres-best-practices-MIT.md` |
| Notice and modifications | `standards/manifests/skills/licenses/supabase-postgres-best-practices-NOTICE.md` |

The root LICENSE file is present on upstream `main`; the pinned commit has no
root LICENSE file, but its skill frontmatter declares MIT. The shipped text is
copied verbatim from the official file. The MIT notice requirements apply: keep
the license text and notice with any copy.

**30 of 37 files carried over.** The original skill has 37 files. The 30 rule
files are byte-for-byte identical to the upstream files at the pinned commit
and are carried unchanged. The other 7 are not carried over verbatim: `SKILL.md`
(rewritten as the portable instructions, with safety rules and a corrected rule
reference, so a modified derivative), `AGENTS.md`, `README.md`, `metadata.json`,
and the rule-authoring files `_contributing.md`, `_template.md`, `_sections.md`.

**Recorded evidence, not runtime verification.** The URLs and the pinned commit
are recorded evidence entered by a reviewer. No validator or test contacts the
network or re-checks upstream. The validator only requires that a
`verified-upstream` license records complete, well-formed evidence (see below).

**Byte-for-byte comparison is a manual validation.** Comparing the carried
files with the external originals needs the original skills directory: set
`DAC_SKILL_ORIGINALS` to it and run `npm test`. That test is skipped when the
variable is unset and is not run in CI. The ordinary catalog safety tests
(schema, policy, license and provenance completeness, layout, content scan)
run in CI on every `npm test`.

## Classification rules (enforced by the validator)

- **License gate.** Instruction text is copied only when redistribution rights are
  verifiable from the source material. Statuses: `verified-license-file` (full
  license text shipped with the source), `declared-spdx` (the author declares an
  SPDX id in frontmatter, no license text), `verified-upstream` (official
  upstream provenance recorded: source URL, pinned commit, license URL, SPDX,
  copyright, plus the shipped license text), `declared-source-only` (free-text
  attribution only) and `none`. Only `verified-license-file`, `verified-upstream`
  and `declared-spdx` may be CORE or OPTIONAL.
  Anything else must be QUARANTINED (or DEPRECATED) and ships no instruction
  body, scripts or references; the catalog entry is the only record (factual
  metadata: origin, digest, license evidence, dependencies, risks, conflicts).
- **Verified-upstream evidence.** Required, in both the catalog entry and the
  manifest (and equal in both): `provenance.source_url` (https),
  `source_commit` (full 40-character lowercase hex, pinned), `source_path`
  (relative), `license_url` (https), `copyright`, `license_scope`, the SPDX id,
  and in the manifest `license_path` pointing at the shipped full license text.
  Missing or malformed fields are rejected. `provenance` is invalid on any other
  license status.
- **External services.** A skill needing an external service, credentials or an
  MCP server can be OPTIONAL at most (never CORE), must be risk `medium` or
  higher, and must never be enabled by default: `auto_enable` is the constant
  `false`, and technology profiles or agents that list such a skill are rejected
  (`auto-enable-external`).
- **Deprecation.** A DEPRECATED skill names `superseded_by` (a non-deprecated
  catalog entry).
- **Layout.** The skills directory may only contain the catalog and the files an
  approved manifest declares (`instructions_path`, `reference_paths`,
  `license.notice_path`, `license.license_path`). Any other file, for example a quarantined skill's body,
  is `unexpected-skill-file`.
- **Counts.** `expected` totals must match the entries exactly.

## Classification summary

- **CORE `supabase-postgres-best-practices`.** MIT, verified official upstream
  provenance (see the section above); guidance only (Read, Grep, Glob). 30 of 37
  files carried unchanged; the entry instructions are rewritten with safety
  rules (no SQL against production, additive migrations, no credentials, RLS
  tests) and fix a source reference to a non-existent rule file.
- **CORE `frontend-design`.** Apache-2.0, full license text shipped with the
  source (`verified-license-file`). Adapted with a modification notice and
  guardrails (existing design system first, accessibility, no unreviewed external
  assets). Write tools limited to `src/**`, `public/**`, `tests/**`.
- **QUARANTINED** skills have no verifiable license or provenance. Besides
  `apify`, `firecrawl`, `stripe-integration`, `find-skills`, `stitch-design-taste`
  and the image-generation skills depend on external services, credentials or
  global installs; `senior-secops` ships executable scripts. The two
  `declared-source-only` skills (`micro-saas-launcher`, `stripe-integration`)
  claim Apache-2.0 for a named source but ship no license text, copyright holder
  or repository reference.
- **DEPRECATED `design-taste-frontend-v1`** calls itself the preserved v1 of
  `design-taste-frontend`.

Duplicated or conflicting originals (the taste/visual-design family, the three
image-generation skills, `apify` vs `firecrawl`, `stripe-integration` vs the
optional `payment-integration` agent) are recorded in each entry's `conflicts`.

## Skill manifest contract

The existing skill schema gains optional fields (older manifests stay valid);
skills listed as CORE/OPTIONAL must declare them all:

- `activation`: when to use it. `auto_enable`: constant `false`.
- `risk`: `low`, `medium` or `high`.
- `license`: `{spdx, evidence (license-file | frontmatter-declaration |
  upstream-verified), attribution, notice_path, license_path?, provenance?}`
  (`license_path` and `provenance` are required for `upstream-verified`); must agree with the catalog.
- `dependencies`: `{skills[], external_services[], runtime_tools[],
  requires_credentials}`; must agree with the catalog.
- `reference_paths`: Markdown files shipped with the skill (relative paths).
- `adapters`: status per tool for `claude-code`, `codex`, `cursor`.
- `permissions`: explicit minimum tools, `production_access: none`,
  `permission_mode` only `default`/`plan`, shell limited to read-only git
  commands, scoped `writable_paths` if a write tool is declared.

One canonical source per skill: the Markdown named by `instructions_path` plus its
references. No provider-specific copies exist; adapters generate those later.

## Adapters: supported vs untested

Compatibility is never claimed without tests. There are no adapters and no
adapter tests yet, so every skill declares `untested` for Claude Code, Codex and
Cursor, and the schema only allows `untested` or `unsupported`. Extending it to
`supported` belongs with the adapter phase and its tests. An adapter manifest
that lists a catalog skill in `supports.skills` is rejected (`adapter-claim`).

## Activation

Skills are opt-in and are not wired into any agent, profile or adapter here. A
skill is used when a task or a future profile names it explicitly; the
`activation` field describes when that is appropriate.

## Security review checks

Instruction and reference text is scanned (read-only, heuristic): machine
paths, credential-shaped values, OpenClaw coupling, Context7 and Spec Kit
references, `bypassPermissions` and skip-permission flags, force push, recursive
delete of root-like targets, pipe-to-shell, `sudo`, shell `-c`/`eval`,
instruction-override and exfiltration phrasing, zero-width and bidirectional
control characters, HTML comments, non-https URLs and script/data URIs. License
text files are scanned only for coupling, secrets and hidden text. Instruction
links and backticked `references/...md` paths must resolve to shipped files.
These are guardrails, not a sandbox or a proof of safety; reference text remains
untrusted input for the agent that reads it.

Optional manual check of the originals: set `DAC_SKILL_ORIGINALS` to the original
skills directory and run `npm test` to compare digests and the verbatim copies.
This is not run in CI; the other catalog tests are.
