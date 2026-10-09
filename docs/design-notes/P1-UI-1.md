# P1-UI-1 — App shell (foundations first; layout paused for the owner's mockup)

**Package:** `apps/web`. **Spec:** doc 48 §10.2, FR-CRMS-UI-4/6/7/8/9/10; doc 50 preamble. **Issue:** #20.

**Status.** The owner asked to approve a mockup of the shell before it is built. This note and the
commits on `p1-ui-1-shell` therefore cover only what no mockup changes: the data layer, the
route manifest, the auth boundary, the permission hook and the command registry. The sidebar,
top bar, palette layout and page screens follow the approved mockup; the route elements are
unstyled placeholders until then.

## Data layer — one client

`api/client.ts` is the only module that calls `fetch`. It knows the base path (`/api`, the same
in dev proxy and at the edge), sends the session cookie (`credentials: 'include'`), echoes the
CSRF cookie in the CSRF header on every mutating method (the names come from
`@bylinecrm/shared`, one definition with the API's guard), and folds every failure into
`ApiError { status, code, message, fieldErrors[] }` — Nest's envelope and nestjs-zod's
validation issues both land there, with issue paths joined by dots so a form can place them.

A 401 is not a page's concern: the client notifies `onUnauthorized` subscribers and the router,
subscribed once, sends the person to sign-in with `returnTo`. Only a same-origin path is
accepted back (`isLocalPath`), so sign-in cannot be used as an open redirect.

`api/types.ts` mirrors the P0-3 views by hand because the OpenAPI document is not on `main`
yet. **Swap point:** when P1-1a commits `apps/api/openapi.json`, this file is replaced by
`openapi-typescript` output and `endpoints.ts` keeps its signatures.

`api/endpoints.ts` builds every path; `api/queries.ts` holds the TanStack Query keys (one list)
and the hooks. The query client does not retry a 4xx: that is the API's answer.

## Route manifest and typed params

`routes/paths.ts` spells every path once; `routes/manifest.tsx` registers exactly that set and
a test proves each entry resolves and the catch-all only answers the rest. Workspace routes sit
under one pathless `RequireAuth` layout. `routes/params.ts` is the one reader of `:workspaceId`
— `useParams` is untyped and a renamed segment otherwise passes the compiler.

## Auth boundary

`RequireAuth` asks `/me`. Pending renders nothing protected; a 401 redirects with `returnTo`;
any other error is thrown to the route's error boundary, because an outage is not a reason to
sign someone out.

## Permission model on the client (FR-CRMS-UI-6)

`useCan(capability)` reads a `MembershipSummary` from `CapabilitiesProvider`; `WorkspaceCapabilities`
fills it from **`GET /w/:workspaceId/me`** — `{ memberId, userId, roleId, roleName, recordScope:
'all'|'own', capabilities[] }` (an API-key principal has `memberId`/`userId` null and `apiKeyId`
set), gated by the workspace guard only. The route ships in P1-1a's PR with the OpenAPI freeze;
until it merges the query answers 404, which reads as "membership unknown": nothing is allowed,
no control is shown on a guess, and the server remains the gate. `usePermission` adds the reason
text a disabled control shows. `recordScope` is carried so list views can say "showing your
records" without a second request.

## Command registry and shortcuts (FR-CRMS-UI-4)

`commands/registry.ts`: `registerCommand`-style contributions scoped to a component's lifetime
(`useRegisterCommands(list, deps)`), one list for the palette and the shortcuts sheet, a `when`
predicate to hide a command, duplicate ids refused. `commands/shortcuts.ts`: the grammar once
(`mod+k`, `?`, chords like `g p` within one second), typing-aware (plain keys and chords are
ignored in a field, modifier shortcuts are not), `formatShortcut` for display per platform. The
palette UI binds these once the mockup fixes its layout.

## Tests (39)

Client: cookie/credentials, CSRF on mutating only, 204, error envelopes, field errors, 401
listeners. RequireAuth: renders on 200, redirects with returnTo on 401. Capabilities: unknown →
nothing, membership answers, reason text. Registry: order, cleanup, duplicate refusal, stale
cleanup, `when`, subscriptions, mount/unmount/deps. Shortcuts: tokens, chords and timeout,
typing rules, display. Paths: safe returnTo. Manifest: every path resolves, catch-all, param name,
auth boundary placement.

## Not in this slice (follows the approved mockup)

Sidebar, top bar, workspace switcher, user menu, palette and shortcuts-sheet UI, settings CRUD
screens, sign-in/sign-up/callback screens, route skeletons and error boundaries as designed,
offline banner, `size-limit` budget (needs the real bundle), the browser walk. P1-UI-2/3/4 add
the data views, record page and pipeline on top of this manifest.
