# dac CLI v1

`bin/dac.mjs` (`dac` in `package.json` `bin`) is a thin facade. It adds no validation, schema,
authentication, transaction, persistence, runtime or orchestration of its own; every command
delegates to an existing component:

| Command | Delegates to |
|---|---|
| `dac init --provider <claude-code\|codex>` | `installer/bootstrap.mjs` (`apply`: dry-run preview, then the same apply) |
| `dac start` / `dac stop` | `adapters/shared/sdd-handoff/custodian-cli.mjs` |
| `dac status [--json]` | bootstrap `verify` + custodian `status` (read-only) |
| `dac sdd plan\|apply --handoff <ID>` (or `--input <file>`) | `adapters/shared/sdd-writer/cli.mjs` |
| `dac sdd verify --project <ID>` | `adapters/shared/sdd-writer/cli.mjs` |

The existing CLIs (`installer/bootstrap.mjs`, the custodian CLI, the writer CLI, per-provider CLIs)
are unchanged and remain usable directly. `dac` installs nothing globally: no PATH, HOME or global
config writes. Run it as `node bin/dac.mjs ...` from this clone (or via `npm link` if you choose).

## Project root

- `init`: the Git top-level (`git rev-parse --show-toplevel`) of the current directory. Not a Git
  repository: fails with zero writes. **Empty folders without Git are unsupported in v1** (the
  standard source gate is not widened); run `git init` first. Final target safety stays with bootstrap.
- everything else: the nearest ancestor of the current directory containing `.dac/standard.json`.

## Commands

- `init` shows the bootstrap dry-run plan, then applies it with the same engine. Exactly one provider;
  `cursor` is rejected and never touched; no provider binary is executed. Idempotent (`Already
  installed`). A first install enables the SDD handoff runtime unless another provider owns it; an
  existing provider keeps its recorded options (context7, optional agents, `sdd_handoff`).
- `start` requires the handoff runtime. Already running is reported and exits 0. Otherwise it runs
  the custodian in the **foreground** (Ctrl-C stops it and destroys all handoffs); no daemon. A stale
  socket left by a killed custodian is cleaned by the custodian itself on start.
- `status` prints bootstrap integrity and custodian state; exit 0 only when bootstrap is `OK`.
- `stop` stops the custodian (or removes a verified stale socket).
- `sdd` runs the writer as a child process with `--target <root>`. The handoff id is always explicit
  (never stored, listed or auto-selected). Plan and apply are never chained. Approval happens only on
  the controlling terminal opened by the writer. Writer exit codes pass through (0, 1, 2, and 3 =
  applied but handoff consumption uncertain: do not re-run apply; run verify).

## Rejected on purpose

Unknown or repeated flags, `--runtime-dir`, `--target`, approval flags (`--yes`, `--approve`, ...),
`--recover-lock`, `--context7`/`--optional-agent` (use `installer/bootstrap.mjs` for those), multiple
providers and `cursor`. Usage errors exit 2.

Tests: `tests/dac-cli.test.mjs` (disposable projects and a throw-away Git copy of this checkout).
