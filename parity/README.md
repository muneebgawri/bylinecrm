# The parity ledger

BylineCRM is built **clean-room**: Twenty is the behavioural reference, never the code base
(corpus doc 48 §3–§4, rulings D-238 and D-243). This directory holds the one artifact that carries
Twenty's behaviour into our build — `LEDGER.md` — and the rules for keeping it that way.

## What the ledger is

One row per Twenty behaviour we have adopted, deviated from, skipped or are watching. Each row is
written **in our words**, describes **observable behaviour only** (what a user or an API client
sees), and records **where it was observed** so a reviewer can check that the row carries
behaviour, not expression. Builders implement from the row and the PRD (doc 48); the row must be
precise enough that a builder needs nothing else.

Columns: `id` (PAR-nnn) · `area` (Twenty's module vocabulary, which our modules share) ·
`behaviour` · `observed` (version / date / source) · `ours` (the doc 48 FR it maps to, or `—`) ·
`status` (`adopted`, `deviates` + why, `skipped` + why, `watching`, `question`).

## Sources, and who may read what (D-243, amended 2026-10-09)

- **Public surface** — always allowed, cited as `docs: <path>`, `changelog vX.Y` or `instance`:
  the documentation site (docs.twenty.com, developers.twenty.com), the public release notes
  (twenty.com/releases), and Pinion's own running workspace through its API/MCP tools.
- **The local source checkout `~/Projects/twenty-crm`** (v1.22.0 at the time of writing) —
  **any role** (ledger author, builder, reviewer) may read it, read-only, cited as
  `source: <package/module path>`. It is used to pin down behaviour the docs leave vague.
- **Never:** clone Twenty, fetch files from github.com/twentyhq/twenty or raw.githubusercontent.com,
  open node_modules, or copy files out of the checkout into this repo.

## The rule that holds

**Never copy or translate. Write from the ledger row.** Reading the source to understand a
behaviour is permitted; re-typing its code, tests, comments, schema text, field descriptions or
error strings — in any language or shape — is not. The ledger itself quotes nothing: no code, no
identifiers lifted as-is where our words will do, no error messages. **The reviewer checks every
PR for structural copying** (same decomposition, same names in the same order, same comments
paraphrased) and refuses it; "it works the same" is the goal, "it is shaped the same" is the defect.

## Taking in a Twenty release

1. Read the public changelog for the release.
2. For anything in scope (doc 48 §2), add a row with `status: watching` and the version.
3. Decide: `adopted` (write the FR or extend one), `deviates` (say why), or `skipped` (say why).
4. Implement from the row through the normal loop (doc 49 §3). The row's `ours` column is updated
   to the FR and the regression row when the package merges.

Rows are never deleted; a behaviour Twenty removes gets `status: skipped — removed upstream vX.Y`.

## Open questions

Rows with `status: question` name what the public surface and the checkout did not settle. They
are closed by a later observation, never by guessing.
