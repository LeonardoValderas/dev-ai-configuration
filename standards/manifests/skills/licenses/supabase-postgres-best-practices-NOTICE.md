# Notice: supabase-postgres-best-practices

## Provenance (recorded evidence)

- Official upstream: https://github.com/supabase/agent-skills
- Skill path: `skills/supabase-postgres-best-practices`
- Source snapshot: commit `f421451c7956d9a79b8257ccc24a7ab6d16037e2`
  (https://github.com/supabase/agent-skills/commit/f421451c7956d9a79b8257ccc24a7ab6d16037e2).
  The carried content corresponds to that historical commit, not to current
  `main`, which may be newer.
- License: MIT (SPDX `MIT`), Copyright (c) 2026 Supabase. Official license file:
  https://github.com/supabase/agent-skills/blob/main/LICENSE. That root file is
  present on upstream `main`; the pinned commit has no root LICENSE, but the
  skill's own frontmatter at that commit declares `license: MIT`.
- These URLs and the commit id are evidence recorded by a reviewer. Repository
  tests do not contact the network and do not re-verify them.
- The full license text is in `supabase-postgres-best-practices-MIT.md` in this
  directory, copied verbatim from the official LICENSE.

## What was carried over and what was modified

The original skill has 37 files. Of these:

- **30 rule files carried over unchanged** (byte-for-byte identical to the
  upstream files at the pinned commit), under
  `references/supabase-postgres-best-practices/`.
- **Modified:** the entry instructions (`supabase-postgres-best-practices.md`)
  are a rewrite of the upstream `SKILL.md` with repository safety rules added
  and a broken rule reference corrected. It is a modified derivative work.
- **Not carried over (7 files):** `SKILL.md` (replaced by the rewrite above),
  `AGENTS.md` (compiled duplicate), `README.md`, `metadata.json`, and the
  rule-authoring files `_contributing.md`, `_template.md`, `_sections.md`.

## License notice requirement

The MIT License requires that the copyright notice and permission notice be
included in all copies or substantial portions of the software. Keep
`supabase-postgres-best-practices-MIT.md` and this notice with any copy or
redistribution of the carried rule files or the derived instructions.
Supabase's name and copyright are not an endorsement of the modifications.
