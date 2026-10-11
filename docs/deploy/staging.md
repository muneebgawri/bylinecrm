# Staging — runbook (P5-4a)

**Where:** `https://staging.crm.pinionnewswire.com`, on the NewswireOS production VPS
(`ssh newswireos-vps`, 169.58.194.188). **What runs:** the `bylinecrm-staging` compose project —
postgres, redis, api, web — from images CI builds for each commit on `main`
(`ghcr.io/muneebgawri/bylinecrm-{api,web}:<sha>`). Nothing is built on the server.

This box serves NewswireOS production, and other sessions deploy NewswireOS to it. Everything below
is written so that BylineCRM cannot take NewswireOS down: read "What this can break" before
changing any of it.

Files: `deploy/docker/` (images), `deploy/staging/` (compose, edge configs, scripts),
`.github/workflows/images.yml` (publishing).

## Layout on the server

| Path                                                           | What                                              | Survives                                                 |
| -------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `/opt/bylinecrm/releases/<sha>/deploy/staging/`                | the deploy files for each release (newest 5 kept) | replaced per deploy                                      |
| `/opt/bylinecrm-runtime/staging.env`, `postgres.env`           | environment, incl. secrets (0600)                 | everything                                               |
| `/opt/bylinecrm-runtime/data/{postgres,redis,attachments}`     | data                                              | everything                                               |
| `/opt/bylinecrm-runtime/DEPLOYED_SHA`, `PREVIOUS_SHA`          | what runs, what ran before                        | everything                                               |
| `/opt/bylinecrm-runtime/deploy.lock/`                          | held during a deploy                              | removed on exit                                          |
| `/opt/newswireos-runtime/nginx-dynamic/bylinecrm-staging.conf` | this host's server blocks on the NewswireOS edge  | NewswireOS deploys (they only write `api-upstream.conf`) |

## One-time setup (in this order)

Run on the server unless marked **Mac**. Do these outside NewswireOS's busy hours, and check first
that no NewswireOS deploy is running: `ls /opt/newswireos-runtime/deploy.lock` must say "No such
file".

1. **DNS (Cloudflare, `pinionnewswire.com`):** A record `staging.crm` → `169.58.194.188`, Proxied —
   like the zone's other hosts; the edge's real-visitor-address handling expects Cloudflare in front.
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

## Routine deploy (Mac)

```sh
deploy/staging/deploy.sh origin/main     # or any commit on origin whose images CI built
DRY=1 deploy/staging/deploy.sh <commit>  # print the plan only
```

The deploy takes its own lock (two BylineCRM deploys cannot overlap), pulls both images before
touching anything (a missing image aborts with the old release still running), migrates, starts
the api and waits for `/health` to report `ok`, starts web and waits until it serves the app and
reaches the api through itself, records `DEPLOYED_SHA`, then probes the public URL once.

It does not take NewswireOS's lock and does not need to: it never touches a NewswireOS container
or file.

## Rollback (Mac)

`deploy/staging/rollback.sh` redeploys `PREVIOUS_SHA` through the same path. Migrations only move
forward, so rolling back images does not roll back the schema. A migration that the previous code
cannot run against needs a forward fix, not a rollback.

## Memory caps and how to check them

| Service            | Cap                                                                          |
| ------------------ | ---------------------------------------------------------------------------- |
| postgres           | 512 MiB                                                                      |
| redis              | 128 MiB (`maxmemory 96mb`, `noeviction` — BullMQ jobs must never be evicted) |
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

| Risk                                                                                   | Prevention                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A BylineCRM edge file makes `nginx -t` fail, so the next NewswireOS release rolls back | `install-edge.sh` tests before and after, restores on failure, and refuses while NewswireOS's deploy lock is held. The file names no upstream that must exist. |
| nginx refuses to start because BylineCRM is down                                       | The upstream is resolved per request (Docker resolver, variable `proxy_pass`, as for Slotline). Down means 502 on this host only.                              |
| BylineCRM exhausts memory                                                              | Hard `mem_limit` on every service (above).                                                                                                                     |
| A BylineCRM deploy restarts NewswireOS                                                 | The scripts address only the `bylinecrm-staging` project, by name, with `--no-deps`. No `docker compose` command here runs in NewswireOS's project.            |
| Builds starve production                                                               | Nothing is built on the server; images come from GHCR.                                                                                                         |
| A NewswireOS deploy deletes BylineCRM state                                            | All BylineCRM state is under `/opt/bylinecrm*`, outside NewswireOS's rsync'd trees. NewswireOS writes only `api-upstream.conf` in `nginx-dynamic`.             |
| Exposed ports                                                                          | No BylineCRM service publishes a port; the edge reaches `web` over `bylinecrm-edge`, and only `web` is on it.                                                  |
| Secrets leak                                                                           | Generated on the server, 0600, never printed, never in the repository (which is public).                                                                       |
