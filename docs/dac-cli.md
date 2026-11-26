# dac CLI v1

`bin/dac.mjs` (`dac` in `package.json` `bin`) is a thin facade. It adds no validation, schema,
authentication, transaction, persistence, runtime or orchestration of its own; every command
delegates to an existing component (`implement` and `review` delegate to `adapters/shared/sdd-run/`, see
[dac-implement-review.md](dac-implement-review.md)):

| Command | Delegates to |
|---|---|
| `dac init [--provider <claude-code\|codex>] [--path <dir>] [--package-name <name>]` | `installer/bootstrap.mjs` (`apply`: dry-run preview, then the same apply; interactive in a terminal) |
| `dac update [--dry-run]` | `installer/bootstrap.mjs` `update` (dry-run preview, then the same update) |
| `dac start` / `dac stop` | `adapters/shared/sdd-handoff/custodian-cli.mjs` |
| `dac status [--json]` | bootstrap `verify` + custodian `status` (read-only) |
| `dac sdd plan\|apply --handoff <ID>` (or `--input <file>`) | `adapters/shared/sdd-writer/cli.mjs` |
| `dac sdd verify --project <ID>` | `adapters/shared/sdd-writer/cli.mjs` |
| `dac implement <task-id> [--project <ID>] [--preserve-dirty] [--model <model>]` | `adapters/shared/sdd-run/implement.mjs`: verified persisted task, trusted-terminal authorization, automatic isolated branch/worktree, injectable runner, blocking audit (no approval flag exists; never commits, merges, publishes or cleans up) |
| `dac review <task-id> [--project <ID>] [--run <run-id>] [--model <model>]` | `adapters/shared/sdd-run/review.mjs`: first runs the authorized `validation_commands` as independent validation in a disposable exact copy of the audited tree (never the worktree), under macOS `sandbox-exec` (network denied, writes only in the copy; non-macOS is BLOCKED); for npm projects (package.json deps + package-lock.json + an `npm` validation command) it first needs a dedicated trusted-terminal approval to provision a private npm cache (network only in that phase; see `docs/dac-implement-review.md`) and installs offline with scripts disabled; blocks on failure/drift, then a separate read-only reviewer bound to the exact audit/diff hash |

`--model <model>` (both commands) is passed unchanged to Codex as `--model <model>`; omitted, Codex inherits its configured model. Model availability is account-specific: you choose it, dac never falls back (see [dac-implement-review.md](dac-implement-review.md)).

The existing CLIs (`installer/bootstrap.mjs`, the custodian CLI, the writer CLI, per-provider CLIs)
are unchanged and remain usable directly. `dac` itself writes nothing global: no PATH, HOME or global
config writes. Run it as `node bin/dac.mjs ...` from this clone, or install the command once (next section).

## Install the `dac` command (one time, user-owned symlink)

Use your **existing checkout** of this repository. Clone only if you do not have one yet
(new install only; never re-clone to update: `git pull` in the existing checkout instead):
`git clone <repository-url> "$DAC_CHECKOUT"`. No `sudo`, no `npm link`, no global package, nothing is
written outside the one symlink below. The checkout must stay where it is (the link points into it).

```sh
# DAC_CHECKOUT = absolute path of your checkout; DAC_BIN_DIR = a directory you own (default ~/.local/bin)
: "${DAC_CHECKOUT:?set DAC_CHECKOUT to the absolute path of your checkout}"
DAC_BIN_DIR="${DAC_BIN_DIR:-$HOME/.local/bin}"
DAC_TARGET="$DAC_CHECKOUT/bin/dac.mjs"
DAC_LINK="$DAC_BIN_DIR/dac"
command -v node >/dev/null 2>&1 || { echo "node not found on PATH (Node 20+ required)" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node 20+ required" >&2; exit 1; }
[ -f "$DAC_TARGET" ] && [ -x "$DAC_TARGET" ] || { echo "$DAC_TARGET is missing or not executable" >&2; exit 1; }
mkdir -p "$DAC_BIN_DIR"
if [ -L "$DAC_LINK" ] && [ "$(readlink "$DAC_LINK")" = "$DAC_TARGET" ]; then
  echo "already linked: $DAC_LINK"
elif [ -e "$DAC_LINK" ] || [ -L "$DAC_LINK" ]; then
  echo "refusing: $DAC_LINK exists and is not a link to $DAC_TARGET" >&2; exit 1
else
  ln -s "$DAC_TARGET" "$DAC_LINK" && echo "linked: $DAC_LINK"
fi
```

(Run it in a shell where `exit` is acceptable, e.g. save it as a script, or paste into a subshell `( ... )`.)
It is idempotent: a correct existing link is left alone, and any other file, directory or link at the
destination is rejected untouched.

PATH is **manual and visible**: nothing edits your shell profile. If `command -v dac` does not find it,
add this line to your own shell startup file yourself and open a new shell:
`export PATH="$HOME/.local/bin:$PATH"` (or your `DAC_BIN_DIR`).

Reversal is unlink-only: `unlink "$DAC_BIN_DIR/dac"` (only if it is the link you made). The checkout,
projects and PATH line are never touched by it; remove the PATH line yourself if you added it.
Use `dac update` (below) for projects; updating the command itself is `git pull` in the checkout.

## Project root

- `init`, in this order: (1) an explicit path (`--path <dir>` or the path typed at the prompt) wins;
  (2) otherwise the nearest ancestor of the current directory containing `.dac/standard.json`;
  (3) otherwise the Git top-level. Not a Git repository: fails with zero writes, except an
  explicit path in interactive mode, where `git init` is offered and runs only after confirmation.
  Final target safety stays with bootstrap.
- everything else: the nearest ancestor of the current directory containing `.dac/standard.json`.

## Commands

- `brief` opens DAC Brief Studio ([docs/brief-studio.md](brief-studio.md)), the static local form at
  `tools/brief-studio/index.html`, resolved from this checkout (never from the current directory). It works
  outside a DAC project and takes no options. On macOS it runs `/usr/bin/open <absolute path>` (argument vector,
  no shell); on other platforms it prints the absolute path and exits 0. If the launch fails it exits 1 and
  prints the path. No server and no network; the form keeps a draft in browser `localStorage`.
- `init` with `--provider` is non-interactive (as before): it shows the bootstrap dry-run plan, then
  applies. Without `--provider`, a terminal is required (stdin and stdout TTY); otherwise it exits 2
  with zero writes. Interactive `init` asks for the existing project path (blank: auto-detect),
  package name, provider and, for an explicit path that is not in a Git repository, whether to run
  `git init`; then it prints the destination, how it was chosen and the full bootstrap plan, and asks
  `[y/N]` before the first write. Declining, Ctrl-C or end of input cancels with zero writes
  (exit 1). A confirmed `git init` creates an unborn repository (no commits). If bootstrap then
  fails, `.git` is removed only when it is provably the one this operation created (same
  directory, byte-identical to right after `init`, unborn, no refs); otherwise it is preserved and
  reported.
- `--package-name <name>` / the prompt record `.dac/project.json` (`{"schema":1,"package_name":...}`,
  managed by bootstrap: journal, ownership, verify, update, uninstall, rollback). It is a package
  name (ecosystem-neutral metadata, **not** a filesystem path), **not** an SDD `project_id`, and no
  ecosystem manifest is ever edited. Accepted: 1-214 characters such as `left-pad`, `@scope/pkg`,
  `My_Package`, `serde_json`, `github.com/Org/Repo/v2`, `com.example:app`; rejected: empty or
  whitespace-only, control characters/NUL/newlines/backslashes, leading or trailing whitespace, a
  leading `-`, absolute paths, empty or `.`/`..` path segments, and anything longer than 214.
  Interactive `init` suggests the prompt default read-only from the project root: the existing
  `.dac/project.json` value first, else one unambiguous name from `package.json` `name`,
  `pyproject.toml` `[project] name`, `Cargo.toml` `[package] name`, `go.mod` `module`, or
  `settings.gradle[.kts]` `rootProject.name` (literal only). Malformed, dynamic, duplicated or
  conflicting manifests give no suggestion (a note is printed) and are never guessed or modified. Without it, installs stay valid and no record is created. The same value is idempotent;
  a different value is shown as `CHANGE` in the preview and needs the interactive confirmation or
  `--replace-package-name` (otherwise zero writes). A drifted record blocks any overwrite.
  `.sdd/` is never touched.
- `update` delegates to bootstrap `update` for the nearest installed project (dry-run preview,
  then apply; `--dry-run` stops after the preview). Installed options, `.dac/project.json`, Context7
  and optional agents are preserved. It is not a self-update of the command.
- `init` applies exactly one provider;
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
