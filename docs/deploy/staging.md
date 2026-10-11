# Staging — runbook (P5-4a)

**Where:** `https://staging.crm.pinionnewswire.com`, on the NewswireOS production VPS
(`ssh newswireos-vps`, 169.58.194.188). **What runs:** the `bylinecrm-staging` compose project —
postgres, valkey, api, web — from images CI builds for each commit on `main`
(`ghcr.io/muneebgawri/bylinecrm-{api,web}:<sha>`). Nothing is built on the server. Postgres and Valkey come from our GHCR
mirror, pinned by digest ([`images.md`](images.md), #123).

This box serves NewswireOS production, and other sessions deploy NewswireOS to it. Everything below
is written so that BylineCRM cannot take NewswireOS down: read "What this can break" before
changing any of it.

Files: `deploy/docker/` (images), `deploy/staging/` (compose, edge configs, scripts),
`.github/workflows/images.yml` (publishing).

## Shared with NewswireOS — read first

Three things on this box belong to both products. Treat them as shared infrastructure:

- **The `bylinecrm-edge` docker network.** NewswireOS's edge container (`newswireos-web-1`) is attached
  to it, NewswireOS's compose declares it as external, and NewswireOS's deploy creates it if it is
  missing. **Never remove it** (`docker network rm bylinecrm-edge`) — that would detach the NewswireOS
  edge. BylineCRM's compose also declares it `external: true`, so no BylineCRM `compose` command can
  create or remove it, and `teardown.sh` only reports who is attached.
- **The edge include file** `/opt/newswireos-runtime/nginx-dynamic/bylinecrm-staging.conf`. NewswireOS
  releases gate their reloads on `nginx -t`, which reads this file. Only `install-edge.sh` and
  `teardown.sh` change it, both by testing `nginx -t` and restoring on failure.
- **The deploy-lock courtesy.** `install-edge.sh` and `teardown.sh` refuse while
  `/opt/newswireos-runtime/deploy.lock` exists (a NewswireOS deploy may be testing and reloading the same
  edge). BylineCRM's own deploys use `/opt/bylinecrm-runtime/deploy.lock`.

## Layout on the server

| Path                                                           | What                                              | Survives                                                 |
| -------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `/opt/bylinecrm/releases/<sha>/deploy/staging/`                | the deploy files for each release (newest 5 kept) | replaced per deploy                                      |
| `/opt/bylinecrm-runtime/staging.env`, `postgres.env`           | environment, incl. secrets (0600)                 | everything                                               |
| `/opt/bylinecrm-runtime/data/{postgres,valkey,attachments}`    | data                                              | everything                                               |
| `/opt/bylinecrm-runtime/DEPLOYED_SHA`, `PREVIOUS_SHA`          | what runs, what ran before                        | everything                                               |
| `/opt/bylinecrm-runtime/deploy.lock/`                          | held during a deploy                              | removed on exit                                          |
| `/opt/newswireos-runtime/nginx-dynamic/bylinecrm-staging.conf` | this host's server blocks on the NewswireOS edge  | NewswireOS deploys (they only write `api-upstream.conf`) |

## One-time setup (in this order)

Run on the server unless marked **Mac**. Do these outside NewswireOS's busy hours, and check first
that no NewswireOS deploy is running: `ls /opt/newswireos-runtime/deploy.lock` must say "No such
file".

1. **DNS (Cloudflare, `pinionnewswire.com`):** A record `staging.crm` → `169.58.194.188`, **DNS only
   (grey cloud) — never Proxied.** Cloudflare's Universal SSL certificate covers one subdomain level
   (`*.pinionnewswire.com`), not `staging.crm.pinionnewswire.com`, so with the record proxied Cloudflare
   has no certificate to present and **every visitor gets a TLS handshake failure** (this happened on
   2026-10-11 when the record was flipped to Proxied). The origin edge terminates TLS itself with its
   own Let's Encrypt certificate for the host (`/etc/letsencrypt/live/staging.crm.pinionnewswire.com/`,
   expires 2027-01-09, renewed by certbot on the server). Unproxied, the edge sees the visitor's address
   directly; its Cloudflare real-address handling only rewrites requests that come from Cloudflare.
   Check: `dig +short staging.crm.pinionnewswire.com` must print `169.58.194.188`, not Cloudflare
   addresses. Putting Cloudflare in front would need a certificate that covers the name (Advanced
   Certificate Manager) or a one-level hostname — a decision, not a toggle.
2. **Images (GitHub):** after the first push to `main` with `images.yml`, check the server can pull:
   `docker pull ghcr.io/muneebgawri/bylinecrm-web:main`. The box already holds a GHCR login for
   NewswireOS's images; if that login cannot read these packages, set both packages
   (`bylinecrm-api`, `bylinecrm-web`) to public in their GitHub package settings — the repository is
   public and the images contain no secrets.
3. **Edge network:** `docker network create bylinecrm-edge`, then
   `docker network connect bylinecrm-edge newswireos-web-1`.
   A network connection survives container restarts but **not a recreate**: if NewswireOS ever
   recreates `newswireos-web-1`, staging answers 502 until it is reconnected. The durable fix is a
   one-line follow-up in NewswireOS's `deploy/docker-compose.prod.yml` declaring `bylinecrm-edge` as
   an external network on `web` — a NewswireOS change, made in that repo by whoever owns it, not by
   this runbook.
4. **Secrets:** copy the scripts up and generate the environment:
   **Mac:** `SYNC=$(git rev-parse origin/main); git archive --format=tar $SYNC deploy/staging | ssh newswireos-vps "mkdir -p /opt/bylinecrm/releases/$SYNC && tar -x -C /opt/bylinecrm/releases/$SYNC"`
   then on the server `bash /opt/bylinecrm/releases/<sha>/deploy/staging/bootstrap-secrets.sh`.
   It prints which secrets it generated, never their values. Re-running it keeps every secret.
5. **Edge, HTTP only:** `bash /opt/bylinecrm/releases/<sha>/deploy/staging/install-edge.sh http`.
   It refuses while a NewswireOS deploy holds its lock or if the edge already fails `nginx -t`, and
   restores the previous state if its own file fails the test. Before running, look at the listen
   directives the edge already uses (`grep -n listen /opt/pressboard/plane/deploy/nginx.conf`): this
   file uses plain `listen 80;` / `listen 443 ssl;`, and nginx rejects differing options on the same
   address — the script would catch that and put the edge back, but it is quicker to see it first.
6. **Certificate:** `certbot certonly --webroot -w /var/www/certbot -d staging.crm.pinionnewswire.com`.
   The renewal config records the webroot, and the existing deploy hook
   (`/etc/letsencrypt/renewal-hooks/deploy/reload-web.sh`) reloads the edge on every renewal.
7. **Edge, HTTPS:** `bash /opt/bylinecrm/releases/<sha>/deploy/staging/install-edge.sh https`
   (refuses if the certificate is missing).
8. **First deploy (Mac):** `deploy/staging/deploy.sh origin/main`. Before step 7 is done, use
   `SKIP_EDGE_PROBE=1`. `DRY=1` prints the plan.

## Sign-up and platform admins (P0-14)

Staging takes no sign-ups: `bootstrap-secrets.sh` writes `SIGNUP_MODE=closed` into `staging.env`. Workspaces
are created by platform admins at `/platform/workspaces`, and each owner joins through the
invitation link the page shows.

- **Who is a platform admin:** the addresses in `PLATFORM_ADMIN_EMAILS` in
  `/opt/bylinecrm-runtime/staging.env` (currently `matt@pinionpartners.co`). The account's email
  must be verified. Change the list through the script, never by editing the file (a re-run
  rewrites it), then restart the api:
  `BYLINECRM_PLATFORM_ADMIN_EMAILS=a@x.com,b@y.com bash deploy/staging/bootstrap-secrets.sh`.
  A run without the variable keeps the stored list.
- **Verifying an existing password account,** once per address, on the server:
  `docker compose -p bylinecrm-staging exec api node dist/cli/platform-verify-email.js <address>`.
  The command refuses any address that is not on the list. A Google sign-in verifies the address
  too, and creates the account if none exists yet.
- **Removing an admin:** re-run the script without the address and restart the api. Access ends
  from the first request after the restart. That delay is accepted; there is no runtime switch.
- **Do not set `SIGNUP_MODE=open` on staging.** The URL is public.

## Transactional mail (P0-15)

Staging runs with `NODE_ENV=production`, so the api boots only with transactional mail configured
(#93, D-246): sign-up verification, invitations and password-reset links go through **Resend**, a
BylineCRM sending-only key on NewswireOS's account, from `no-reply@pinionnewswire.com`.

- **`MAIL_FROM`** is written by `bootstrap-secrets.sh` (`BylineCRM <no-reply@pinionnewswire.com>`).
- **`RESEND_API_KEY`** is installed by the owner and kept by every later `bootstrap-secrets.sh` run.
- **Installing or rotating the key.** Copy the key to the clipboard on the Mac and run:

    ```
    pbpaste | ssh newswireos-vps 'bash /opt/bylinecrm/releases/<sha>/deploy/staging/install-resend-key.sh'
    ```

    `<sha>` is any release that has the script: the one a refused deploy names, or
    `$(cat /opt/bylinecrm-runtime/DEPLOYED_SHA)` once a release with it is live. The key travels
    only on stdin. It is never an argument, never printed (the script shows its last four
    characters), and the file stays 0600. Then `docker compose -p bylinecrm-staging restart api`,
    or deploy.

- **The deploy checks first.** A release whose environment lacks the key is refused by the
  environment check (below, #120) before anything is migrated or restarted; the refusal names
  `RESEND_API_KEY` and prints the install command for that release. On a server without a key the
  first deploy therefore goes: deploy (refused, with the command) → install the key → deploy again.
- **Checking delivery:** sign up or reset from a test address, then look in the Resend dashboard
  (Emails) or at the received message's headers (SPF, DKIM and DMARC pass for pinionnewswire.com).

## Routine deploy (Mac)

```sh
deploy/staging/deploy.sh origin/main     # or any commit on origin whose images CI built
DRY=1 deploy/staging/deploy.sh <commit>  # print the plan only
```

The deploy takes its own lock (two BylineCRM deploys cannot overlap), then:

1. **Writes this release's environment** by running the release's own `bootstrap-secrets.sh`. A
   value the release newly derives (a new variable such as `MAIL_FROM`, a renamed service's
   `REDIS_URL`) is written before anything reads it; secrets, `PLATFORM_ADMIN_EMAILS` and the
   installed Resend key are kept. There is no manual "run bootstrap-secrets before the deploy" step.
2. **Pulls both images** before touching anything (a missing image aborts with the old release
   still running).
3. **Checks the environment against the new image** (#120): `node dist/cli/check-env.js` runs in
   the new api image with `staging.env` and the api's own schema. Every variable the new build
   would refuse to boot without is listed by name (never by value) and the deploy stops: nothing
   migrated, the old api still serving. Fix what it names, then deploy again.
4. Migrates, starts the api and waits for `/health` to report `ok`, starts web and waits until it
   serves the app and reaches the api through itself, records `DEPLOYED_SHA`, then probes the
   public URL once.

It does not take NewswireOS's lock and does not need to: it never touches a NewswireOS container
or file.

## Rollback (Mac)

`deploy/staging/rollback.sh` redeploys `PREVIOUS_SHA` through the same path. Migrations only move
forward, so rolling back images does not roll back the schema. A migration that the previous code
cannot run against needs a forward fix, not a rollback.

## Teardown (on the server)

`deploy/staging/teardown.sh` (in any release directory) removes staging and nothing shared:

```
bash /opt/bylinecrm/releases/<sha>/deploy/staging/teardown.sh --yes
```

1. removes the edge include file, reloading the edge only after `nginx -t` passes without it (on failure
   it puts the file back, shows the error and re-tests);
2. removes the `bylinecrm-staging` project's containers and its own `internal` network;
3. keeps `/opt/bylinecrm-runtime/data`, the secrets and the release files — add
   `--purge-data --i-understand-this-deletes-staging-data` to delete the data for good;
4. **keeps the `bylinecrm-edge` network** and prints which containers are still attached.

It refuses without `--yes` and while either deploy lock is held. To bring staging back after a
teardown, run the routine deploy (the network and secrets are still there; install the edge file again
with `install-edge.sh https`).

## Memory caps and how to check them

| Service            | Cap                                                                          |
| ------------------ | ---------------------------------------------------------------------------- |
| postgres           | 512 MiB                                                                      |
| valkey             | 128 MiB (`maxmemory 96mb`, `noeviction` — BullMQ jobs must never be evicted) |
| api                | 768 MiB                                                                      |
| migrate (one-shot) | 384 MiB                                                                      |
| web                | 64 MiB                                                                       |

About 1.5 GiB in steady state on an 11 GiB box. Check with
`docker stats --no-stream $(docker ps -q --filter label=com.docker.compose.project=bylinecrm-staging)`.
A service at its cap is OOM-killed and restarted by Docker; it cannot take memory from NewswireOS.

## Logs and state

```sh
cd /opt/bylinecrm/releases/$(cat /opt/bylinecrm-runtime/DEPLOYED_SHA)/deploy/staging
BYLINECRM_SHA=$(cat /opt/bylinecrm-runtime/DEPLOYED_SHA) docker compose -p bylinecrm-staging -f docker-compose.yml logs --tail 100 api
BYLINECRM_SHA=$(cat /opt/bylinecrm-runtime/DEPLOYED_SHA) docker compose -p bylinecrm-staging -f docker-compose.yml ps
```

## What this can break on the shared box, and how it is prevented

| Risk                                                                                   | Prevention                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A BylineCRM edge file makes `nginx -t` fail, so the next NewswireOS release rolls back | `install-edge.sh` tests before and after, restores on failure, and refuses while NewswireOS's deploy lock is held. The file names no upstream that must exist.                                                                      |
| nginx refuses to start because BylineCRM is down                                       | The upstream is resolved per request (Docker resolver, variable `proxy_pass`, as for Slotline). Down means 502 on this host only.                                                                                                   |
| BylineCRM exhausts memory                                                              | Hard `mem_limit` on every service (above).                                                                                                                                                                                          |
| A BylineCRM deploy restarts NewswireOS                                                 | The scripts address only the `bylinecrm-staging` project, by name, with `--no-deps`. No `docker compose` command here runs in NewswireOS's project.                                                                                 |
| Builds starve production                                                               | Nothing is built on the server; images come from GHCR.                                                                                                                                                                              |
| A NewswireOS deploy deletes BylineCRM state                                            | All BylineCRM state is under `/opt/bylinecrm*`, outside NewswireOS's rsync'd trees. NewswireOS writes only `api-upstream.conf` in `nginx-dynamic`.                                                                                  |
| Exposed ports                                                                          | No BylineCRM service publishes a port; the edge reaches `web` over `bylinecrm-edge`, and only `web` is on it.                                                                                                                       |
| The shared `bylinecrm-edge` network is removed, detaching NewswireOS's edge            | It is `external: true` in BylineCRM's compose (no `compose` command creates or removes it), no script runs `docker network rm`, and `teardown.sh` only reports its members. NewswireOS's deploy recreates it if it is ever missing. |
| Secrets leak                                                                           | Generated on the server, 0600, never printed, never in the repository (which is public).                                                                                                                                            |
