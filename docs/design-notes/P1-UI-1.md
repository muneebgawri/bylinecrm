# P1-UI-1 — App shell: sign-in, workspace picker, navigation, ⌘K palette, theme

**Package:** `apps/web` + `packages/ui`. **Spec:** doc 48 §10.2, FR-CRMS-UI-4/6/7/8/9/10; doc 50
preamble; the approved mockup `docs/design/shell-mockup-v3.html` (the visual spec — read, never
imported). **Issue:** #20.

## Order of work

The owner asked to approve a mockup before the shell was built, so the branch has two layers:
the non-visual foundations first (data layer, route manifest, auth boundary, permission hook,
command registry), then the shell to mockup v3 once it was approved.

## Data layer — one client

`api/client.ts` is the only module that calls `fetch`: `/api` base, `credentials: 'include'`, the
CSRF cookie echoed in its header on mutating methods (names from `@bylinecrm/shared`), every
failure folded into `ApiError { status, code, message, fieldErrors[] }`. A 401 is not a page's
concern: the client notifies `onUnauthorized`, the router (subscribed once) sends the person to
sign-in with a `returnTo` that only accepts a same-origin path.

`api/types.ts` mirrors the response views by hand. `api/schema.d.ts` is generated from
`apps/api/openapi.json` by `openapi-typescript` and is where request bodies come from.
**The committed contract is too thin for a generated client:** 47 operations, **no response
schemas**, and 32 operations without their `{workspaceId}` path parameter declared. `openapi-fetch`
over that document would need a cast on every workspace route, which is a band-aid; the one thin
client stays until the freeze carries responses and path params (a P1-1a follow-up).

`endpoints.ts` builds every path; `queries.ts` holds the query keys and hooks. A 4xx is never retried.

## Route manifest, params, boundary

`routes/paths.ts` spells every path once; `routes/manifest.tsx` registers exactly that set and a
test proves each entry resolves. Workspace routes sit under one pathless `RequireAuth` layout and
then `AppShell`. Each route declares `handle.crumb` (the breadcrumb) and an `errorElement`
(`RouteError`: 403 and 404 in their own words, anything else with the message it got; Retry and
Go back). Settings pages are a lazy chunk. `useWorkspaceId()` is the one reader of the param.

## Permission model (FR-CRMS-UI-6)

`useCan(capability)` reads `MembershipSummary` from `CapabilitiesProvider`; `WorkspaceCapabilities`
fills it from **`GET /w/:workspaceId/me`** (`memberId, userId, roleId, roleName, recordScope,
capabilities[]`; verified against the real route 2026-10-09). Until it answers, nothing is
allowed: no nav item, no create entry, no command is shown on a guess; the server remains the
gate. `usePermission` adds the reason text for a disabled control.

## Command registry and shortcuts (FR-CRMS-UI-4)

`commands/registry.ts`: pages contribute commands for their lifetime; one list feeds the palette
and the shortcuts sheet; `when` hides; duplicate ids are refused. `commands/shortcuts.ts`: the
grammar once (`mod+k`, `?`, chords `g p` within a second), typing-aware, `formatShortcut` per
platform. The shell registers: a Go-to command per nav item (from `shell/nav.ts`, the same list
the sidebar draws), Create person/company/deal, Search, Toggle sidebar, **Toggle theme**, Keyboard
shortcuts, Switch workspace, Sign out. The palette groups them Suggested (recently run, persisted)
/ Go to / Create / Account.

## The shell (mockup v3)

- **Tokens** (`packages/ui/src/tokens.css`): the mockup's values for both themes; `color-scheme`
  follows the theme so native controls match. Radii 12/8/6 px + pill; the three shadows; Inter
  self-hosted (`fonts.css`, OFL alongside). **Four values deviate from the mockup** because they
  were under WCAG AA at small sizes and the a11y gate refuses them: light accent `#6d4aff→#6a48f7`
  (4.39→4.61 on accent-soft), light success `#17803d→#167c3b` (4.47→4.70), light muted/faint
  `#667085/#98a2b3→#5f6877/#656f7d` (faint was 2.4:1 on white; it is used for 11–12px labels), dark
  faint `#6b7687→#7f8c9f` (3.5→4.7). Each is the nearest passing value; the look is the mockup's.
- **Theme** (owner requirement): light / dark / system under one key, in two places — the user
  card's menu (radio group) and the ⌘K "Toggle theme" command (`mod+shift+l`); `system` follows
  `prefers-color-scheme`; every story ships in light, dark and compact.
- **Layout**: `AppShell` is a grid — 240px sidebar (64px collapsed, persisted under one key), 56px
  top bar, scrolling main with 28px padding. Under 900px the sidebar is a left `Drawer` and the
  search field collapses to its icon.
- **Sidebar**: workspace switcher (logo mark, name, "BylineCRM", menu of workspaces + All
  workspaces) → four groups with 12px labels from `shell/nav.ts`, each item gated by its capability,
  active = raised bg + 1px border + small shadow, badges right-aligned → user card (avatar, name,
  email, menu: theme, shortcuts, sign out). Collapsed, labels become `sr-only` so each link keeps
  its name and shows a tooltip.
- **Top bar**: collapse toggle, breadcrumb from the route handles, 280px search button with the
  ⌘K key cap, bell with unread dot (no feed yet — the dot is the mockup's), black "+ Create" pill
  whose menu (person, company, deal, note, task) is filtered by capability and navigates to the
  list with `?create=…` until the create dialogs land (P1-UI-2/3/4).
- **States** (FR-CRMS-UI-7): `RouteSkeleton` (the page's shape, no shift), `RouteError`, designed
  `EmptyState`s on every content page with the right words, `OfflineBanner` above the content that
  never hides it.
- **Settings** (admin): Members (role change, remove with confirmation; cannot remove yourself),
  Roles (editor over the capability catalogue grouped by subject; admin is read-only by design),
  API keys (secret shown once with an announced copy result), Invites (link shown once; email is
  not sent yet — the API says so). All on `DataTableChrome`.
- **Auth screens**: centred card with the logo mark; provider buttons from `/auth/providers`;
  sign-in returns the person to `returnTo`; sign-up creates the workspace; the callback asks `/me`
  once and says what happened rather than looping.

## Components added to `packages/ui` (names from the spec)

`PageHeader`, `KpiCard`, `Delta`, `StatusBadge` (= `Badge` with `accent` and `shape`), `Avatar` +
`AvatarCell`, `ScoreBar`, `DataTableChrome` (+ `tableClasses`, `pageWindow`), `BulkBar` (+
`BulkBarAction`), `Drawer` (+ `DrawerSection`), `FactGrid`, `StageProgress`, `ActivityTimeline`,
`ActionList`, `KanbanBoard`/`KanbanLane`/`DealCard`/`CardChip`, `SegmentedControl`,
`WelcomePanel`, plus `IconTile` (the one tinted tile they share), `Field` (label/control/error
wiring) and `lib/tones.ts` (the one meaning-to-colour map). `Button` gained `accent`, `shape`
(pill default, square) and `xs`; `ThemeProvider` reads storage through `lib/persisted.ts`, which
the shell reuses. Every component has a story in three modes; 78 stories pass axe at AA.

## Performance (FR-CRMS-UI-10)

Route-level splitting (`lazy` settings chunk), a `vendor` chunk for the framework, and
`apps/web/.size-limit.json`: initial JS ≤ 190 kB gzip (184.7 kB today: React, Router, Query, the
design system and the shell), stylesheet ≤ 40 kB (8.3 kB). New CI job **`bundle`** runs it.

## Tests

ui: 15 (Button, Dialog, DataTableChrome, Drawer, SegmentedControl, Avatar helpers, …). web: 48 —
client, RequireAuth, capabilities (incl. the `/w/:id/me` wiring), registry, shortcuts, paths,
manifest, Sidebar (capability gating, active item, collapsed names), CommandPalette (groups,
run, Suggested), SignIn (providers, post, returnTo, 401 wording), Members (rows, "You").

## Not in this slice

Dashboard/People/Companies/Deals content (P1-UI-2/3/4), outreach pages (Phase 3), the create
dialogs, notifications feed (the bell is a placeholder), invitation email, password reset (API
501). Fresh worktrees need `pnpm install` + `pnpm --filter @bylinecrm/shared build` (README).
