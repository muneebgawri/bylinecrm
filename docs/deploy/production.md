# Production — runbook (P5-4c)

**Where:** `https://crm.pinionnewswire.com`, on the NewswireOS production VPS (`ssh newswireos-vps`,
169.58.194.188), beside NewswireOS and beside BylineCRM staging. **What runs:** the
`bylinecrm-production` compose project — postgres, valkey, and the api and web **colours** (blue or
green) — from the images CI builds for each commit on `main` (`ghcr.io/muneebgawri/bylinecrm-{api,web}:<sha>`).
Nothing is built on the server. Postgres and Valkey come from our GHCR mirror, pinned by digest
([`images.md`](images.md), #123).

**One mechanism for both environments.** Every script in `deploy/env/` takes the environment name
first (`staging` | `production`); `deploy/env/lib.sh` is the one table of what differs:

| Environment  | URL                                      | Compose project        | Runtime directory                   | Edge include file           | Caps (api / postgres / valkey / web) |
| ------------ | ---------------------------------------- | ---------------------- | ----------------------------------- | --------------------------- | ------------------------------------ |
| `staging`    | `https://staging.crm.pinionnewswire.com` | `bylinecrm-staging`    | `/opt/bylinecrm-runtime`            | `bylinecrm-staging.conf`    | 768m / 512m / 128m / 64m             |
| `production` | `https://crm.pinionnewswire.com`         | `bylinecrm-production` | `/opt/bylinecrm-production-runtime` | `bylinecrm-production.conf` | 1g / 1g / 192m / 64m                 |

Both share `/opt/bylinecrm/releases/<sha>/` (the uploaded deploy files; the newest five of each
environment are kept), the `bylinecrm-edge` docker network, and the NewswireOS edge. Staging keeps the
runtime directory it was created with: moving a live stack's data for a tidier name is risk for no
return.

This box serves NewswireOS production, and other sessions deploy NewswireOS to it. Read
[`staging.md`](staging.md) § "Shared with NewswireOS" first: the `bylinecrm-edge` network is never
removed, the edge include files are only ever changed through `install-edge.sh`/`teardown.sh`
(`nginx -t` before and after, restore on failure), and both refuse while a NewswireOS deploy holds
`/opt/newswireos-runtime/deploy.lock`.

## One-time setup (in this order)

Run on the server unless marked **Mac**. Check first that no NewswireOS deploy is running:
`ls /opt/newswireos-runtime/deploy.lock` must say "No such file".

1. **DNS (Cloudflare, `pinionnewswire.com`):** A record `crm` → `169.58.194.188`, **DNS only (grey
   cloud) until step 6 has issued the certificate.** After that the record may be **Proxied**: unlike
   `staging.crm`, `crm.pinionnewswire.com` is one subdomain level, which Cloudflare's Universal SSL
   covers, and the edge already takes the visitor's address from `CF-Connecting-IP` for requests that
   come from Cloudflare's published ranges (its `set_real_ip_from` block) and leaves every other
   request's address alone — so the same server block serves both modes and nothing restricts by IP.
   If proxied, set Cloudflare's SSL mode to **Full (strict)** so Cloudflare verifies the origin's
   Let's Encrypt certificate; certbot's HTTP-01 renewals keep working through the proxy.
2. **Upload this release's deploy files (Mac):**
   `SYNC=$(git rev-parse origin/main); git archive --format=tar $SYNC deploy/env | ssh newswireos-vps "mkdir -p /opt/bylinecrm/releases/$SYNC && tar -x -C /opt/bylinecrm/releases/$SYNC"`.
   Below, `<rel>` is `/opt/bylinecrm/releases/$SYNC/deploy/env`.
3. **Secrets and environment:**
   `BYLINECRM_PLATFORM_ADMIN_EMAILS=matt@pinionpartners.co bash <rel>/bootstrap-secrets.sh production`.
   It creates `/opt/bylinecrm-production-runtime/` with `production.env` and `postgres.env` (0600),
   generates the Postgres passwords and `SECRETS_KEY` on the box, and prints which secrets it
   generated, never their values. Re-running it keeps every secret and the admin list.
4. **Resend key (Mac):** copy the production sending key to the clipboard, then
   `pbpaste | ssh newswireos-vps 'bash <rel>/install-resend-key.sh production'` — the key travels
   only on stdin and is never printed (the script shows its last four characters). A separate key
   from staging's is preferable (it can be rotated alone); the same key works.
5. **Edge, HTTP only:** `bash <rel>/install-edge.sh production http` — the ACME challenge path and a
   redirect to https; it references no upstream, so `nginx -t` cannot depend on BylineCRM.
6. **Certificate:** `certbot certonly --webroot -w /var/www/certbot -d crm.pinionnewswire.com`.
   The existing deploy hook (`/etc/letsencrypt/renewal-hooks/deploy/reload-web.sh`) reloads the edge
   on every renewal.
7. **Edge, HTTPS:** `bash <rel>/install-edge.sh production https` — renders the server blocks for
   `crm.pinionnewswire.com` sending traffic to the blue web colour (no colour runs yet; the host
   answers 502 until step 8). Refuses if the certificate is missing.
8. **First deploy (Mac):** `deploy/env/deploy.sh production origin/main`. Starts the blue colour
   (postgres, valkey, migrate, api-blue, web-blue), records `ACTIVE_COLOUR=blue`, probes the URL.
9. **Google OAuth (Google Cloud, project Pinion Newswire, client BylineCRM):** add
   `https://crm.pinionnewswire.com/api/mail/oauth/callback` as a redirect URI, then in the CRM
   Settings → Google enter the client ID and secret (the secret through the form, never in chat or a
   shell). The first mailbox that connects confirms the redirect URI.
10. **First platform admin:**
    `cd <rel> && BYLINECRM_SHA=$(cat /opt/bylinecrm-production-runtime/DEPLOYED_SHA) BYLINECRM_ENV=production docker compose -p bylinecrm-production --profile blue exec api-blue node dist/cli/platform-bootstrap-admin.js matt@pinionpartners.co`
    (use `api-green` when `ACTIVE_COLOUR` says green). It refuses an address not in
    `PLATFORM_ADMIN_EMAILS`; on a fresh server it creates the account, verified, and prints a
    single-use set-password link valid 30 minutes — no password is ever printed (#101). Sign-up is
    closed (`SIGNUP_MODE=closed`, P0-14): every workspace is created at `/platform/workspaces`.
11. **Backups:** `bash <rel>/install-backup.sh production` (below), then run one by hand and read it.
12. **Cloudflare proxy (optional, after step 6):** flip the `crm` record to Proxied, SSL mode Full
    (strict). Check `curl -sI https://crm.pinionnewswire.com/health` still answers 200.

## Routine deploy (Mac)

```sh
deploy/env/deploy.sh production origin/main     # or any commit on origin whose images CI built
DRY=1 deploy/env/deploy.sh production <commit>  # print the plan only
```

The deploy takes the environment's own lock (`/opt/bylinecrm-production-runtime/deploy.lock`;
two deploys of one environment cannot overlap, and staging's lock is separate), then
`release-remote.sh production <sha>` runs on the server:

1. **Writes this release's environment** by running the release's own `bootstrap-secrets.sh`
   (secrets, `PLATFORM_ADMIN_EMAILS` and the Resend key are kept; a newly derived value is written).
2. **Pulls both images** before touching anything.
3. **Checks the environment against the new image** (#120): `node dist/cli/check-env.js` runs in
   the new api image with `production.env`. Every variable the new build would refuse to boot
   without is listed by name and the deploy stops; the live colour keeps serving.
4. **Migrates** with the new image, while the live colour keeps serving against the new schema —
   so migrations are **expand now, contract later**: add a column or table, deploy, backfill, and
   only drop the old one in a later release. A rename-in-one-step breaks the colour still serving.
5. **Blue/green cutover, no dropped request:**
    - starts the idle api colour and waits until its `/health` says `ok`;
    - points every running web container at it (`web-dynamic/api-upstream.conf` names the colour;
      `nginx -s reload` inside each web container: new workers use the new api, old workers finish
      their requests on the old one);
    - starts the idle web colour and waits until it serves the app and reaches the api through itself;
    - renders the edge file for that web colour and reloads the NewswireOS edge through
      `install-edge.sh` (`nginx -t` first; on failure the previous file is restored and the deploy
      reverts);
    - after a short drain, stops the old web colour (SIGQUIT: it finishes in-flight requests, then
      exits) and the old api colour (SIGTERM: the api closes its listener, finishes in-flight requests
      and lets its workers finish their current job — `main.ts` enables Nest's shutdown hooks), and
      removes both;
    - records `ACTIVE_COLOUR`, `DEPLOYED_SHA` (the previous one in `PREVIOUS_SHA`), prunes old
      release directories (the newest five of each environment are kept).

    A failure before the edge switch reverts: the web upstream goes back to the old api colour, the
    new colour is removed, and the old colour — which never stopped serving — stays live. The first
    deploy with this mechanism also drains the pre-colour `api`/`web` containers of an environment
    created before it (staging).

6. **Probes** `https://crm.pinionnewswire.com/health` once through the edge.

Two colours run side by side for the length of the cutover (about a minute): plan memory for twice
the api cap during a deploy (the box has headroom; `free -m` before a deploy if in doubt). Both
colours' background workers run during that minute; every worker is safe to run twice (the outbox
relay and the mail relay lease their rows, BullMQ jobs are claimed once).

## Rollback (Mac)

`deploy/env/rollback.sh production` redeploys `PREVIOUS_SHA` through the same path — a blue/green
release of the previous images, so it costs no downtime either. Migrations only move forward: a
migration the previous code cannot run against needs a forward fix, not a rollback.

## Backups

`deploy/env/backup.sh production` writes, under `/var/backups/bylinecrm-production/`:
`bylinecrm-<stamp>.dump` (pg_dump custom format), `roles-<stamp>.sql` (the app role the RLS policies
name) and `attachments-<stamp>.tar.gz`, each under a `.part` name until complete. Retention: every
daily set for 14 days, Sunday's set for 8 weeks — locally and offsite alike. Tonight's set is
**copied** (never synced) to the rclone remote `r2:bylinecrm-backups/production/<yyyy>/<mm>/`.

- **Install the nightly timer:** `bash <rel>/install-backup.sh production`. It copies the backup
  tooling of that release to `/opt/bylinecrm/tools/production/` (a stable path, independent of
  which release directories are kept) and enables `bylinecrm-backup@production.timer` (02:47 UTC,
  after NewswireOS's own 02:17 backup; `Persistent=true`, so a run missed while the box was down
  happens at boot). Re-run it after a change to `backup.sh` lands.
- **Offsite:** by default the same rclone config NewswireOS uses (`/root/.config/rclone/rclone.conf`, remote
  `[r2]`); production and staging upload through the bucket-scoped `r2-bylinecrm` remote instead, set per
  environment in `/opt/bylinecrm-<env>-runtime/backup.env` (#166): `BYLINECRM_BACKUP_REMOTE=r2-bylinecrm:bylinecrm-backups/<env>`
  and, if the config is elsewhere, `BYLINECRM_RCLONE_CONF=…`. Write it once with
  `BYLINECRM_BACKUP_REMOTE=… bash <rel>/bootstrap-secrets.sh <env>` (kept on every later run); `lib.sh` reads it
  for the timer's unit and a manual `backup.sh` alike, so the two never disagree — no systemd drop-in, and
  `install-backup.sh` removes one left from before. Create the bucket `bylinecrm-backups` once in Cloudflare R2. If the remote is missing the
  local backup still runs and the unit **fails** (exit 1, visible in `systemctl list-timers` and
  `journalctl -u bylinecrm-backup@production`) — a missing credential must never turn the job into
  a silent no-op.
- **Logs:** `journalctl -u bylinecrm-backup@production --since yesterday`.
- **Restore drill** (monthly, and after any change to `backup.sh`):
  `/opt/bylinecrm/tools/production/restore.sh production <stamp>` restores the set into a scratch
  database `bylinecrm_restore_<stamp>` and a scratch attachment directory, touching nothing live, and
  prints the table, people and file counts to compare with the live ones. Then
  `restore.sh production <stamp> --drop-scratch`. A set that is not local is fetched from R2 first.
- **Real restore:** `restore.sh production <stamp> --into-live` — stops the api colours (the site
  answers 502 meanwhile), asks for `production` to be typed, replaces the database and the
  attachments (the previous attachment directory is kept beside the new one), and tells you to
  deploy the current release to bring the api back. Never scripted.

## Sign-up, platform admins, transactional mail

As on staging ([`staging.md`](staging.md) §§ "Sign-up and platform admins", "Transactional mail"),
with `production` as the environment argument and `/opt/bylinecrm-production-runtime/production.env`
as the file: `SIGNUP_MODE=closed` is written by `bootstrap-secrets.sh` and must stay so; the admin
list changes only through `BYLINECRM_PLATFORM_ADMIN_EMAILS=… bash <rel>/bootstrap-secrets.sh production`
followed by a deploy; the Resend key only through `install-resend-key.sh production`.

## Teardown (on the server)

```
bash <rel>/teardown.sh production --yes
```

asks for the word `production` to be typed at the terminal (no flag replaces that), then removes
the edge include file (reloading the edge only after `nginx -t` passes without it), the project's
containers and its own networks, and keeps the data, the secrets and the release files. Data is
deleted only with `--purge-data --i-understand-this-deletes-production-data`. The shared
`bylinecrm-edge` network is never removed.

## Logs and state

```sh
R=/opt/bylinecrm-production-runtime; C=$(cat $R/ACTIVE_COLOUR)
cd /opt/bylinecrm/releases/$(cat $R/DEPLOYED_SHA)/deploy/env
BYLINECRM_ENV=production BYLINECRM_SHA=$(cat $R/DEPLOYED_SHA) docker compose -p bylinecrm-production --profile $C -f docker-compose.yml logs --tail 100 api-$C
docker ps --filter label=com.docker.compose.project=bylinecrm-production
```

## Memory caps and how to check them

| Service            | Cap                                                                           |
| ------------------ | ----------------------------------------------------------------------------- |
| postgres           | 1 GiB                                                                         |
| valkey             | 192 MiB (`maxmemory 160mb`, `noeviction` — BullMQ jobs must never be evicted) |
| api (per colour)   | 1 GiB                                                                         |
| migrate (one-shot) | 384 MiB                                                                       |
| web (per colour)   | 64 MiB                                                                        |

About 2.3 GiB in steady state, 3.4 GiB during a cutover, on an 11 GiB box that also runs NewswireOS
and BylineCRM staging (~1.5 GiB). Check with
`docker stats --no-stream $(docker ps -q --filter label=com.docker.compose.project=bylinecrm-production)`.
A service at its cap is OOM-killed and restarted by Docker; it cannot take memory from NewswireOS.
