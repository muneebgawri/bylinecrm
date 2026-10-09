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

Requires Node ≥ 22.12 (`.nvmrc`; `require(esm)` is used for two ESM-only libraries), pnpm 9.15 (`corepack enable`), Docker. PostgreSQL ≥ 14 (the migrations use SQL-standard function bodies; the local stack and CI run 16).

```bash
cp .env.example .env            # ports: Postgres 5441, Redis 6391, API 3300, web 3301; APP_URL/WEB_URL for auth
docker compose up -d            # local Postgres + Redis
pnpm install
pnpm --filter @bylinecrm/shared build
pnpm --filter api prisma:generate
pnpm --filter api db:setup      # creates the restricted role from RLS_DATABASE_URL, then applies migrations
pnpm dev                        # api on :3300, web on :3301 (proxies /api → api)
curl -s localhost:3300/health   # {"status":"ok","db":"ok","redis":"ok","rls":"ok","version":"0.0.0"}
```

## Gates (all run in CI; run them before you push)

```bash
pnpm typecheck
pnpm lint && pnpm format:check
pnpm test
pnpm --filter api test:cross-tenant   # needs the local stack
pnpm scan:licences
pnpm scan:identifiers
```

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

## Records (P1-1a)

- `/api/w/:id/people` and `/api/w/:id/companies`: list (`?limit`, `?cursor`, `?sort=field:asc|desc`, `?q`), get, create,
  patch, delete (soft), `POST …/:id/restore`; the trash is `GET …/deleted` (`record:write`). `GET /api/w/:id/me` is the
  caller's own standing (role, record scope, capabilities) for the UI's permission-aware controls.
- A role's `recordScope` (`all` | `own`) decides whether its holders see every record or only the ones they own; the
  rule is applied by the route and enforced again by a restrictive row-level policy.
- `/api/w/:id/custom-fields`: definitions per object; values travel in a record's `custom` object and are validated
  against them.

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
