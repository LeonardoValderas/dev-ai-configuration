# Security Principles

These principles govern how any tool, adapter, or automation built on
top of this standard must behave. They apply regardless of which AI
coding tool is in use.

## 1. Least privilege

Tools and automations operate with the minimum access and permissions
required for the task at hand. Do not request or retain broader scope
than necessary.

## 2. No secrets in the repository

No API keys, credentials, tokens, session data, private keys, or
certificates are ever committed. Only safe, non-sensitive examples
(e.g. `.env.example`) are tracked. See `.gitignore` for enforced
exclusions.

## 3. No bypass of permission prompts by default

Automation must not disable, skip, or bypass permission/confirmation
checks (e.g. "dangerously skip permissions" style flags) unless a
human has explicitly and separately authorized it for a specific,
scoped action.

## 4. Preserve existing Git state

Automation must not discard, overwrite, or force-push over existing
uncommitted work, branches, or history without explicit authorization.
Destructive Git operations are avoided by default; reversible
alternatives are preferred.

## 5. No destructive, remote, migration, deployment, or production
   changes without explicit authorization

Any action that is destructive, affects remote/shared systems, runs a
data migration, or touches a deployment or production environment
requires explicit, scoped human authorization before it is taken. This
is never assumed from prior approvals of unrelated actions.

## 6. Independent validation

Claims of correctness or completion are validated independently of the
process that produced the change, rather than self-certified by the
same step that made the change.

## 7. Evidence-based PASS

A validation result of PASS must be backed by concrete evidence (test
output, reproducible steps, logs) — not asserted without support.

## 8. Separation of execution status from validation result

Whether a task was *executed* (ran to completion without error) is a
distinct fact from whether its *result* is valid or correct. Reporting
must keep these two dimensions separate rather than conflating "it ran"
with "it worked."
