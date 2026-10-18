# BylineCRM

A decoupled, hosted multi-tenant CRM service. Specification: `pinion-dashboard-v2-docs` docs 48 (PRD),
49 (build plan), 50 (wireframes); owner rulings D-236…D-242.

Built **clean-room**: no third-party CRM source is copied, translated or adapted (doc 48 §3). CI enforces
a licence allowlist and an identifier scan (`scripts/`).

## Layout

| Path                 | What                                                               |
| -------------------- | ------------------------------------------------------------------ |
| `apps/api`           | NestJS 11 · Prisma 6 on PostgreSQL 16 · ioredis + BullMQ · Vitest  |
| `apps/web`           | Vite · React 19 · React Router 7 · Tailwind 4 · Vitest             |
| `packages/shared`    | Types shared by both (`@bylinecrm/shared`) and the base `tsconfig` |
| `parity/`            | The behaviour ledger (doc 48 §4) — owned by the ledger author      |
| `docs/design-notes/` | One note per work package (doc 49 §3, loop step 2)                 |
| `scripts/`           | The licence and identifier gates; `db-ensure-app-role.mjs`         |

## Run it locally

Requires Node ≥ 22.12 (`.nvmrc`; `require(esm)` is used for two ESM-only libraries), pnpm 9.15 (`corepack enable`),
PostgreSQL 16 and Valkey 9.1 (D-250 — the versions CI and staging run; the migrations need PostgreSQL ≥ 14 for
SQL-standard function bodies). On macOS they run natively, no Docker: `brew install postgresql@16 valkey`, then
`scripts/dev-native-db.sh setup` starts a Postgres cluster of BylineCRM's own and a Valkey, on the ports below, bound
to 127.0.0.1 and started at login (`status`, `stop`, `purge` do what they say). Elsewhere, `docker compose up -d`
runs the same two on the same ports.

```bash
cp .env.example .env            # ports: Postgres 5441, Valkey 6391, API 3300, web 3301; APP_URL/WEB_URL for auth
scripts/dev-native-db.sh setup  # macOS; or: docker compose up -d
pnpm install
pnpm --filter @bylinecrm/shared build
pnpm --filter api prisma:generate
pnpm --filter api db:setup      # creates the restricted role from RLS_DATABASE_URL, then applies migrations
pnpm dev                        # api on :3300, web on :3301 (proxies /api → api)
curl -s localhost:3300/health   # {"status":"ok","db":"ok","redis":"ok","rls":"ok","version":"0.0.0"}
```

### Environment you must set before deploying

- **`SECRETS_KEY`** — 32 random bytes, base64 (`openssl rand -base64 32`); webhook signing secrets (and later
  customers' OAuth client secrets) are encrypted with it. Keep it in the secret store with a backup: if this key is
  lost, every secret sealed with it is unrecoverable and each webhook endpoint must be rotated.
- **`WEBHOOK_WORKER`** — `1` (default) runs webhook delivery in this process; `0` on an API when a separate worker
  process runs it.
- **`MAIL_SYNC_WORKER`** — `1` (default) runs Gmail sync in this process (a sync of every connected mailbox every
  two minutes, and a first import when one connects); `0` on an API when a separate worker process runs it. The
  cross-tenant suite sets `0`.
- **`MAIL_SEND_WORKER`** — `1` (default) runs the send job in this process (a queued message goes out through Gmail);
  `0` on an API when a separate worker process runs it. The cross-tenant suite sets `0`.
- **`CALENDAR_SYNC_WORKER`** — `1` (default) runs calendar sync in this process (CAL-1: a read of every personal
  mailbox's Google Calendar every ten minutes, and a first read when one connects); `0` on an API when a separate
  worker process runs it. The cross-tenant suite sets `0`.
- **`NOTIFICATIONS_WORKER`** — `1` (default) runs the task notification jobs in this process (#192: due reminders
  every 15 minutes and the morning digest at 03:00 UTC); `0` on an API when a separate worker process runs them. The
  cross-tenant suite sets `0`.
- **`WEBHOOK_ALLOW_PRIVATE_TARGETS`** — `0` in every deployed environment (it admits private/loopback webhook
  targets, for local receivers only; the Twenty importer's base URL is held to the same rule).
- **`TWENTY_IMPORT_WORKER`** — `1` (default) drives Twenty import runs in this process (P4-4); `0` on an API when
  a separate worker process runs them.

## Webhooks (P1-5)

Admins register endpoints under `/api/w/:id/webhooks`; deliveries are signed (`x-byline-signature`, HMAC-SHA256 over
`<t>.<raw body>`), queued in BullMQ, retried with backoff, and swept if a job was lost. Receiver example, retry
policy and SSRF rules: `docs/design-notes/P1-5.md`.

A deal's stage move is delivered as exactly one event: `deal.won` or `deal.lost` when it closes, `deal.stage_changed`
for every other move (reopening included). All three carry the same `stage` payload; subscribe to all three to see
every move.

## Gates (all run in CI; run them before you push)

```bash
pnpm typecheck
pnpm lint && pnpm format:check
pnpm test                            # package suites run one at a time: three vitest pools at once starve the app-compiling specs
pnpm --filter api test:cross-tenant   # needs the local stack
pnpm scan:licences
pnpm scan:identifiers
```

- **bundle** — `pnpm --filter web build && pnpm --filter web size`: the initial JS and the stylesheet stay under
  the budgets in `apps/web/.size-limit.json` (gzip). Raise a budget in the PR that needs it, with the reason.
- **routes** — `pnpm --filter web build && pnpm --filter web test:routes`: every page, the record drawer and
  the ⌘K palette at 375 / 768 / 1280px in light and dark — axe at WCAG 2.1 AA, no sideways scroll, 44px touch
  targets and 16px field text on phones, the primary action (`data-primary-action`) on screen, phone
  screenshots against baselines. The API is answered from `apps/web/e2e/fixtures.ts`; a page that calls an
  endpoint with no fixture fails. A new page is visited automatically (it comes from `paths.ts`). Baselines
  come from the CI runner only: push, then `pnpm --filter web routes:baseline`, and commit
  `apps/web/e2e/__snapshots__/`. Details: `docs/design-notes/P0-10.md`.

## Signing in (P0-3)

- Local: `POST /api/auth/signup` (`email`, `password` ≥ 12 chars, `workspaceName`) → session cookie `blc_session`
  (httpOnly) + `blc_csrf`; send the latter's value as `x-csrf-token` on every POST/PATCH/DELETE. `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET /api/me`, `GET /api/me/workspaces`.
- Google / OIDC: set `GOOGLE_CLIENT_ID`+`GOOGLE_CLIENT_SECRET` and/or `OIDC_ISSUERS` (JSON) in `.env`; register the
  redirect URI `APP_URL/api/auth/oidc/<key>/callback`; the browser goes to `GET /api/auth/oidc/<key>`
  (`/api/auth/google` for Google). Identity scopes only — never Gmail.
- Tenant routes live under `/api/w/:workspaceId/…` and each declares the capability it needs (`@Requires`). Roles,
  members, API keys and invitations: `/api/w/:id/{roles,members,api-keys,invites}`. API keys are `blc_<prefix>_<secret>`,
  sent as `Authorization: Bearer …`.
- OpenAPI: `GET /api/docs` (UI) and `/api/docs-json`.

Migrations: `prisma migrate dev` is interactive and does not run under this harness; CI and the recipe above use
`migrate deploy`. After editing `schema.prisma`, write the migration SQL by hand (see any under
`apps/api/prisma/migrations`), apply it with `pnpm --filter api db:setup`, then prove the live database matches the
schema the way CI does:
`pnpm --filter api exec dotenv -e ../../.env -- prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code`.
Never pass `DATABASE_URL` as a `--shadow-database-url`: a shadow database is reset.

## Records (P1-1a)

- `/api/w/:id/people` and `/api/w/:id/companies`: list (`?limit`, `?cursor`, `?sort=field:asc|desc`, `?q`), get, create,
  patch, delete (soft), `POST …/:id/restore`; the trash is `GET …/deleted` (`record:write`). `GET /api/w/:id/me` is the
  caller's own standing (role, record scope, capabilities) for the UI's permission-aware controls.
- A role's `recordScope` (`all` | `own`) decides whether its holders see every record or only the ones they own; the
  rule is applied by the route and enforced again by a restrictive row-level policy.
- `/api/w/:id/custom-fields`: definitions per object; values travel in a record's `custom` object and are validated
  against them.

## Deals, notes, tasks, attachments (P1-1b)

- `/api/w/:id/opportunities`: as people and companies (`deal:read` / `deal:edit`); `amount` is exact minor units
  with a currency that defaults to the workspace's. Stages arrive with P1-2.
- `/api/w/:id/notes` and `/tasks`: attached to records through `targets` (`{type, id}[]`); list by
  `?target=person:<id>` (tasks also by `?assigneeId=`); visible to whoever can see a target (tasks: or the
  assignee); `note:write` / `task:write`.
- `/api/w/:id/attachments?target=…`: multipart upload (`file` field, ≤ `ATTACHMENT_MAX_BYTES`, allowlisted
  types), metadata, `GET …/:id/content` download; bytes live under `FILE_STORAGE_ROOT` (`.env`, git-ignored).
- `GET /api/w/:id/members/summary`: members as pickers show them (`memberId`, `name`), readable with `record:read`.

## Email verification (P3-5)

Before a person is enrolled in a sequence, and again before every email step, their address is verified without
touching the recipient's mail server: syntax, the domain's MX records, the disposable-domain list, role-address
detection. `valid` enrols; `invalid` (no such domain, no mail server, a disposable domain) is refused (and stops a
running enrolment before its next email); `risky` (a role address) enrols and is flagged in the preview; `unknown` (DNS did not answer) is not
valid and does not enrol. A result stands for 90 days unless Settings → _Verification_ says otherwise, then is
found again before the next send. The API is `/api/w/:id/outreach/verification` (the age) and
`/api/w/:id/people/:personId/verification` (a person's result; `POST` re-runs it). Why each result is what it
is: `docs/design-notes/P3-5.md`.

## Postmaster Tools (#129)

An admin connects, on the Mailboxes page, the Google account that owns the outreach sending domains in Postmaster
Tools, through the workspace's own OAuth client (Postmaster's read scope only, never Gmail's). Every sending-domain
check then reads the domain's user-reported spam rate for the day before and, at or past the pool's complaint
threshold, pauses every pool mailbox on the domain. Nothing calls Google until the one-time step in
`docs/design-notes/P3-2.md` (enable the Postmaster Tools API, add the scope to the consent screen, verify the
domains at postmaster.google.com) is done: until then each domain reports "not connected" and nothing pauses.

## Enrichment (P4-2)

A new person or company — and one whose address or domain changes — is looked up in four free sources: the
company's website (name, logo, LinkedIn and X profiles, the domain it is served from), DNS (its mail provider),
Gravatar (a person's picture) and the addresses themselves (a person's country, a company's domain). Every answer
is kept with its source and the time it was asked; it is written to the record only when better than what is
there (an empty field takes any answer; what a member typed is never replaced); no answer is kept as no answer. A
record's _Enrichment_ card shows the answers and offers _Enrich now_; Settings → _Enrichment_ turns sources off
and sets how long an answer stands (90 days unless set). Jobs run in a worker (`ENRICHMENT_WORKER`). The API is
`/api/w/:id/enrichment/...`. The rule per field type: `docs/design-notes/P4-2.md`.

## Tracking (P3-4)

Links in outreach email are shortened through a domain of the workspace's — Settings → _Tracking_ sets it and
shows the CNAME to publish; `POST /api/w/:id/tracking/domain/check` verifies it through DNS — and only once it
is verified: until then, links go out as written. A click on a short link (`GET /r/:token` on that domain)
redirects to the original URL and is recorded on the person's timeline as `email.clicked`, which a stage rule
may act on like a reply. Opens come from a pixel (`GET /o/:token`) and are **indicative** everywhere they are
shown: mail clients prefetch images, so an open never moves a stage or stops a sequence. Hits from known link
scanners, and any within two seconds of delivery, are kept out of every count. Personal 1:1 mail and
unsubscribe links are never rewritten. The rules, the bot filter and the open questions (the edge must route
the short-link hosts to the API): `docs/design-notes/P3-4.md`.

## Import from Twenty (P4-4)

Settings → _Import from Twenty_ (an admin's): connect a Twenty workspace (its URL and an API key, sealed at rest),
check it (Twenty's count per object beside what is mapped here), start a run and follow it. A run reads every object
through Twenty's REST API a page at a time and maps each record by its Twenty id, so it can be run again: what changed
is updated, what did not is left alone, and nothing is imported twice. Twenty hides deleted records, so deletions
are never mirrored: a _Reconcile with Twenty_ run writes nothing and flags the records here that Twenty no longer
returns as missing in Twenty, listed on the screen for review — nothing is deleted on its own (#156, D-252). What
lands where, and why: `docs/design-notes/P4-4.md`. The API is `/api/w/:id/import/twenty` (`workspace:admin`).

## Working against the mock

`apps/api/openapi.json` is the frozen contract (doc 49 §1). A UI package builds against it before the real endpoint
exists:

```bash
pnpm mock:api                           # Prism serves the contract on MOCK_API_PORT (.env; default 3310)
curl -s localhost:3310/api/w/00000000-0000-4000-8000-000000000000/people | head
```

Changing the API means regenerating the file in the same PR — `pnpm --filter api openapi:write` — and the unit test
`openapi.spec.ts` fails until you do, so the diff of the contract is always in the review.

## Working on it

One work package per branch and PR (doc 49 §5); the loop in doc 49 §3 is the process. The standing rule:
no hot patches, no band-aids, no divergence — one definition of each thing.

A package is built in its own git worktree (`git worktree add -b <branch> ../bylinecrm-wt-<pkg> main`). A fresh
`git worktree` inherits no `node_modules`, no built `@bylinecrm/shared` and no generated Prisma client:
run `pnpm install`, `pnpm --filter @bylinecrm/shared build` and `pnpm --filter api prisma:generate` there before
`pnpm typecheck`, or the errors are stale artefacts, not code.
