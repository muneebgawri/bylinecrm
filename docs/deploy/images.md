# Third-party images (#123)

Every container image BylineCRM runs that it does not build itself — the Node base of both
Dockerfiles, nginx for the web image, and the Postgres and Valkey services in CI, staging and the
local `docker-compose.yml` — comes from **our own mirror on GHCR, pinned by digest**:
`ghcr.io/muneebgawri/mirror/<name>@sha256:…`.

**Why.** CI runs on GitHub-hosted runners that share IP addresses. Public registries throttle
anonymous pulls per IP (Docker Hub's pull limit, then ECR Public's "Data limit exceeded" on
2026-10-11), so builds failed for reasons unrelated to the code. GHCR pulls are authenticated with
the workflow's own `GITHUB_TOKEN` (`packages: read`), and the digest pin makes every build use the
exact bytes it was tested with.

## How it fits together

| Piece                                 | Role                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/images/mirror.json`           | The one list: each image's `name`, upstream `source`, `tag` and `digest`.                                                                                         |
| `.github/workflows/mirror-images.yml` | Copies `source@digest` → `mirror/<name>:<tag>` byte for byte (crane), and checks the copy's digest.                                                               |
| `scripts/check-image-refs.mjs`        | CI's `lint` job: fails on any public-registry or unqualified image, a mirror image by tag or by a digest the list does not hold, and a listed image used nowhere. |

Because the copy is byte for byte, **the mirror's digest is the upstream digest** — anyone can
compare `crane digest ghcr.io/muneebgawri/mirror/postgres:16` with `crane digest postgres:16`.

The mirror runs when the list or its workflow changes on any branch (so a bump is copied by the
push that makes it, before CI on that push pulls it), weekly (keeping the packages warm and warning
when an upstream tag has moved on), and by hand. It never runs for pull requests.

**Visibility.** The packages are **public**, linked to this public repository: they are unmodified
public images, so nothing is exposed, and the local `docker-compose.yml` and any self-hoster can pull
them without a GitHub login. CI still pulls authenticated; staging pulls with the GHCR login the
server already holds.

## Bumping an image

1. Find the new upstream digest of the tag (the weekly run's warning prints it), e.g.
   `crane digest postgres:16`, or change the tag and take its digest.
2. In **one PR**: change `tag`/`digest` in `deploy/images/mirror.json`, and replace the old digest
   at every reference. `pnpm images:check` lists each one it still finds.
3. Push. `mirror-images` copies the new digest on that push; CI then pulls it. Check the
   `mirror-images` run is green before re-running a CI job that failed to pull.
4. After merge, deploy staging as usual — its compose file now names the new digest.

Adding an image: add an entry, reference it as `ghcr.io/muneebgawri/mirror/<name>@<digest>`, push.
Removing one: remove its references and its entry together (the check refuses an unused entry).
