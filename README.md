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

Requires Node 22 (`.nvmrc`), pnpm 9.15 (`corepack enable`), Docker.

```bash
cp .env.example .env            # ports: Postgres 5441, Redis 6391, API 3300, web 3301
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

## Working on it

One work package per branch and PR (doc 49 §5); the loop in doc 49 §3 is the process. The standing rule:
no hot patches, no band-aids, no divergence — one definition of each thing.
