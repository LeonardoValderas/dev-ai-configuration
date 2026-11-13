# Adopting SDD

Nothing here is automated by this repository. Spec Kit is **not installed or
executed** in this phase; the steps marked *future* describe what an approved,
adapter-based installer would have to do. See [sdd.md](sdd.md) for the
methodology.

## New project (methodology only, works today)

1. Pick a mode (Full for anything new or unclear).
2. Create an `sdd-project` record with objective, scope, requirements and
   acceptance criteria. Resolve open questions before planning.
3. Record decisions, risks and owned tasks (owners must be mapped agents with
   `may_implement`).
4. Obtain a human approval for `pre-implementation` and record it. Do not start
   implementation, file changes, migrations, production mutations or deployments
   before the matching gate is approved.
5. Implement inside scope; keep `files_changed` covered by task paths.
6. Have the independent validator (`code-reviewer`) verify every criterion and
   record evidence before any `PASS`.
7. Validate the record: `node installer/validate.mjs standards/sdd
   standards/manifests/agents <dir-with-your-project-record>`.

If the project has milestone files, reference them with `milestone_ref`; they
are never modified.

## Existing project

Before any future `specify init`, all of these are mandatory preconditions
(recorded in the manifest as `existing_project_preconditions`):

1. **Inspect**: read-only review of the repository, including any existing
   `.specify/`, `specs/`, agent command directories, milestone files and
   conventions.
2. **Backup**: a complete backup of every managed path and every existing file
   an init could touch, taken before any write and outside the project tree.
3. **Conflict report**: list every path the init would create or overwrite,
   with a content comparison. Any conflict aborts (`abort-on-conflict`); the
   report is reviewed by a human.
4. **Explicit approval** of the install and of the exact init command.

*Future* init (not run in this phase): `specify init <project> --integration
<key>` with an explicit integration key; unattended use additionally needs
`--non-interactive`. `--force` (acknowledging a merge into a non-empty
directory) is never a default and always needs its own explicit approval.
Install source: `uv tool install specify-cli --from
git+https://github.com/github/spec-kit.git@v1.4.0`, pinned to the tag, through an
approved adapter only.

*Future* rollback: restore from the backup and verify the restored tree matches
it. Confirm the managed paths against the pinned release first (they are
provisional).

Until then, adopt the methodology alone: write `sdd-project` records next to the
existing work and validate them as above.
