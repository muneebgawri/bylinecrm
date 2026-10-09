# P1-UI-4 — Pipeline board and its list twin

**Package:** `apps/web` (the deals route) + `packages/ui` (Toast). **Spec:** doc 50 §B, the approved
mockup `docs/design/shell-mockup-v3.html` (Deals), FR-CRMS-UI-1/3/4/10. **Issue:** #33. Builds on P1-2
(pipelines, board, move, history) and P1-4 (filter, sort, views on the board route).

## One query, two renderings

`/w/:id/deals` reads **one** query — `GET /pipelines/:id/board` under the page's saved view, inline filter,
sort and search — and renders it as lanes or as a table. Both read the same cache entry
(`keys.board(workspace, pipeline, {view, filter, sort, q})`); toggling never refetches. The URL carries
everything a shared link needs: `pipeline`, `show=board|list` (the rendering), `view` (a saved view's id —
the API's own parameter name), `filter` (base64url JSON), `sort`, `q`. The rendering is also remembered per
person under `bylinecrm.deals.view` through the design system's storage helper.

`show` rather than `view` for the rendering: since P1-4, `view` is the saved-view parameter on every list
and board route, and one name with two meanings in one URL is the divergence the standing rule forbids.

Counts and per-currency sums are the API's for the filtered, scoped set; the client never adds them up
(an optimistic move moves the card, not the totals; the refetch after the answer brings the API's
numbers back).

## Moving a deal — one hook, four controls

Drag (dnd-kit, `PointerSensor` with a 6 px activation distance), the keyboard twin, the list's inline
stage select and the bulk bar all call `useDealMove().request(deal, stageId)`:

1. `classifyMove` (pure) says what the move means: same lane (nothing), forward, backward, and whether
   the target is a won/lost stage.
2. A **close** opens `CloseDealDialog` first — won amount prefilled from the deal, or a required lost
   reason — and nothing is sent on cancel. The API's close payload is what the dialog produces.
3. A **backward** move opens `BackwardMoveDialog`, which names the enabled rules whose target is ahead
   of the new stage ("Reply received → Replied"): a rule may move it forward again.
4. `useMoveDeal` paints optimistically in every cached board of the pipeline (`onMutate`), puts the
   previous boards back on an error (the snap-back), and refetches either way. The hook toasts the
   server's own message on a refusal and announces each step in the page's live region.

**Keyboard contract** (FR-CRMS-UI-4/8): focus a card, Space picks up ("Series B PR picked up from New…"),
←/→ choose a lane ("Series B PR, Contacted, position 1 of 2"), Space drops, Escape puts it back. The target
lane is ringed while chosen. Without `deal:move` a card is focusable and announced but cannot be picked up;
the drop zones are disabled.

Bulk moves are refused for won/lost stages with a toast that says why: a close records a won amount or a
lost reason per deal, which a bulk action cannot ask for.

## Opening a deal

A click or tap on a card, Enter on a focused card, or a deal's name in the list opens its record drawer
over the board through P1-UI-3's `?open=opportunity:<id>` (`withOpen`) — the board stays where it was and
a refresh or shared link reopens it. A press that travels 6 px is a drag on a pointer device, so a click
is never mistaken for one.

## Phones and touch (FR-CRMS-UI-12)

One breakpoint: `BREAKPOINT_PX.mobile` (768) in `packages/ui/src/lib/breakpoints.ts`, which is Tailwind's
`md` (`--breakpoint-md: 48rem` declared in `theme.css`; `breakpoints.spec.ts` fails if they differ). CSS
says `max-md:`, script says `useIsMobile()`. The shell's sidebar width (900) lives in the same file as
`narrow`; the shell's own media-query module is gone in favour of the design system's hook.

- **Board, under 768px:** one stage per screen in a horizontal scroll-snap strip, and a row of stage chips
  (name, count, 44px) on top that follows the swipe and jumps to a stage.
- **Moving on touch:** no drag on a finger (`(pointer: coarse)` or a phone) — each card has **"Move to
  stage"**, which opens `MoveSheet`, a list of 44px stage rows; it calls the same `request` as everything
  else, so a close still asks for its payload and a backward move still names the rules ahead. dnd-kit
  stays for pointer devices; the keyboard twin works everywhere.
- **Sheets:** below 768px every `Dialog` in the design system is a bottom sheet (full width, anchored to
  the bottom, safe-area padding, scrolling inside, a 44px close) — the close dialog, the backward-move
  dialog, "Add a filter", "Save view", "New deal" and the move sheet with no per-dialog code.
- **List, under 768px:** stacked cards — name (opens the drawer), amount and owner, a full-width stage
  select, days in stage, close date — with a 44px selection toggle and the same bulk bar, which spans the
  width and scrolls its actions instead of the page.
- **Rows that scroll sideways, not the page:** the view picker and filter chips, the stage chips, the bulk
  bar. Inputs and selects are 16px / 44px on a phone (iOS does not zoom); buttons and the segmented
  control have a 44px minimum there. All of this is `max-md:` in the primitives, so desktop sizes and the
  visual baselines (taken at 1024px) are unchanged.

## Saved views and filter chips (P1-4, wired here)

- **View picker** — "All deals", then shared views and the member's own (`GET /views?object=opportunity`).
  Selecting one sets `view=` and clears any inline filter/sort, because an inline filter replaces the
  view's whole (the API's rule, kept visible). "Save current filters as a view…" (`view:save`), "Share
  with the workspace" (`view:share`, own views), "Update" and "Delete" where the member may change the view.
- **Filter chips** — the conditions of a top-level `and`, each removable. "+ Filter" opens a dialog whose
  fields and operators come from `STANDARD_FIELDS.opportunity` and `OPERATORS_BY_KIND` in
  `@bylinecrm/shared` (one vocabulary with the API); values are typed per kind (money in minor units,
  dates as `YYYY-MM-DD`). A filter with `or` groups (saved elsewhere) shows as one "Advanced filter" chip.
- **Owner** is offered only to members whose scope is `all`; an own-scoped member's board is already theirs.
- `lib/filterParam.ts` is the one encoder/decoder (base64url of the JSON, byte-identical to Node's).

Not here: `company`/`point of contact` conditions (they need record pickers — P1-UI-2/3), custom-field
conditions (the definitions endpoint is wired in P1-UI-2's settings), and an `or`-group editor.

## Components

- `packages/ui`: **Toast** — `toast-store.ts` (store, `toast()`, `useToasts`; no Radix, imported anywhere)
  and `Toaster.tsx` (Radix Toast renderer) published as the subpath `@bylinecrm/ui/toaster` so the shell
  loads it lazily. A refusal stays 8 s, a confirmation 5 s; at most three at once. Story in the three modes.
- `apps/web/src/lib/money.ts`: the one money formatter over the one `Money` type (whole amounts without
  minor digits; per-currency sums joined with " · "); `parseMoneyInput` for typed amounts.
- `KanbanLane` / `DealCard` from P1-UI-1 are used as they are; lanes virtualise (TanStack Virtual) past
  `LANE_FOLD` (50) cards; a column the API truncated (`hasMore`) offers "N more — see the list".

## Performance (FR-CRMS-UI-10)

The deals route is a lazy chunk carrying dnd-kit, TanStack Table and TanStack Virtual (45 kB gzip). The
`vendor` chunk now matches only the framework's TanStack package (React Query) — it used to match every
`@tanstack/*`, which would have put Table and Virtual on every page's first load.

**The budget measures what `index.html` loads.** `.size-limit.js` reads the built HTML and counts its entry
script and every modulepreload, so no chunk escapes by its name. (A glob of chunk names undercounted: when
the toast renderer was split out, Rollup made a shared chunk every page preloaded and no pattern named, and
the reported figure fell by 18 kB while the page did not get lighter.)

**`packages/ui` declares `"sideEffects": ["*.css"]`.** Every component module calls `forwardRef`/`cva` at
the top level, which a bundler must keep unless told the package has no side effects; without the
declaration, every component in the barrel shipped on every page's first load. With it, a page loads the
components it uses. Today: **180.6 kB of 190 kB** — about 11 kB less for every page than before this card.

## A lint rule turned off, once, with its reason (architect decision)

`react-hooks/incompatible-library` warned on `useVirtualizer` and `useReactTable` — the libraries the card
fixed. The rule reports **React Compiler** compatibility (the compiler would skip a component using a
library whose hooks return mutable instances); this build does not run the compiler, so the warning
describes nothing that happens, and in plugin 7.1.1 the `'use no memo'` directive does not silence it.
Decision: the rule is off in `packages/eslint-config/react.mjs` only — one config change, no per-file
disables — with the reason and the condition to re-enable it (adopting the compiler, at which point those
components opt out with `'use no memo'`) written beside it.

## Tests

`DealsPage.spec.tsx` (14): one query key for both renderings; keyboard pick-up → choose → drop with the
announcements and the move request; Escape sends nothing; a 409 snaps back and toasts the server's reason;
won/lost opens the close dialog first, cancel moves nothing, a lost reason is required and sent; without
`deal:move` nothing can be picked up and there is no "New deal" without `deal:edit`; the API's sums
formatted and the past-threshold chip; a filter chip reaches the board as base64url; removing it removes it;
saving a view sends the filter and then drives the board by `view=`; no Owner filter for an own-scoped
member; the rendering choice is remembered. `filterParam.spec.ts` (4): round trip incl. non-ASCII, byte
identity with Node's base64url, garbage → no filter, chip edits. `Toast.spec.tsx` (3).

## Not in this slice

The pipeline settings page
(stages, colours, thresholds, rule editor) — registered as a designed placeholder at
`/settings/pipelines` so "Configure pipeline" lands somewhere honest. Forecast view; group-by rendering. CSV export
is the toolbar's "Export CSV" link to P1-4's `opportunities/export.csv` with the page's view, filter, sort and
search — a download, not a selection export.
