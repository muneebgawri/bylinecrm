# P1-UI-9 — exit-check UI defects

Issue #67, from the Phase 1 exit check. Four defects, each fixed at its source, and two of them
now held by the route gate.

## 1. The dark-mode backdrop lightened the page (FR-CRMS-UI-9)

Dialog and Drawer drew their overlay as `bg-text/35` / `bg-text/40`. `--bc-text` is near-white in
dark mode, so the "scrim" lightened the page. There is now one token, `--bc-scrim`: a near-black in
both themes (light `rgba(16,24,40,0.4)`, dark `rgba(0,0,0,0.6)`), mapped to the `bg-scrim` utility
and used by every overlay (Dialog, which also backs the ⌘K palette and every phone bottom sheet,
and Drawer). `scrim.spec.tsx` (ui) and `scrim.spec.ts` (web) fail on any `bg-text/<n>` in source.

## 2. Screen readers heard ids when a deal was dragged (FR-CRMS-UI-8)

dnd-kit speaks through its own live region, which is `aria-live="assertive"` with no option to
change it, and its default announcements read the draggable's and droppable's ids. The board also
has its own polite region for the keyboard twin and the server's answer, so the two talked over
each other.

`makeDndAnnouncements({ itemName, containerName, position?, isHome?, announceDrop?, announce })`
in `packages/ui/src/lib/dnd-announcements.ts` builds dnd-kit's `Announcements` from names. Every
callback speaks through the page's ONE polite region (`announce`) and returns `undefined` to
dnd-kit, so dnd-kit's assertive region never speaks. It is structural (packages/ui does not depend
on dnd-kit); TypeScript checks the fit where it is passed to `DndContext`. The board passes
`announceDrop: false` because its move hook says the outcome ("moving to …", "moved to …", or the
refusal); a drop back where the card came from says "put back in X". `DND_INSTRUCTIONS` replaces
dnd-kit's default instructions. P1-UI-8's stage reorder should use the same helper.

## 3. Phone record pages had no bottom action bar (FR-CRMS-UI-12)

A record page declares its actions once, as a `RecordAction[]` (`records/recordActions.tsx`).
`RecordHeaderActions` renders the list as header buttons on a tablet or desktop; `RecordActionBar`
renders the same list in `BottomActionBar` (packages/ui) on a phone, with "More" (a sheet holding
previous/next record) when there is something to put in it. On a phone the header's actions and
its previous/next buttons are hidden. An unavailable action explains itself: a tooltip on hover
and focus in the header, a toast on tap in the bar (a phone has no hover).

The bar is `sticky bottom-0`, not `fixed`, as the last child of a wrapper that spans the whole
record (`RecordLayout`'s new `bar` slot). It stays on screen through the scroll and still takes its
own space at the end of the content, so nothing hides behind it; its bottom padding includes the
safe-area inset. The record page's phone padding is now 16px, matching every other phone page.

## 4. The deals board's chrome pushed the first card below the fold (FR-CRMS-UI-12)

On a phone the page header, view bar, search, toolbar, "Configure pipeline" and the rules line
stacked above the board. Now a phone shows one row: the pipeline (picker or name), Board/List,
a "Filters" button with a count of settings in force, and an icon "New deal". The view bar,
search, filter, sort, export, the rules line and "Configure pipeline" open together in one Filters
sheet. Each of those controls is defined once in `DealsPage` and placed either in the page
(tablet, desktop) or in the sheet (phone).

## The gate

Two new phone checks in `apps/web/e2e` (`checks.ts`), driven by per-state promises in `states.ts`:

- `bottom-bar` — person, company and deal pages and both record drawers must show a visible
  `[data-bottom-bar]` inside the viewport.
- `above-fold` — on the deals board, the first `[data-deal-id]` must end above 667px (iPhone SE),
  checked against that line rather than the gate's taller phone viewport.

On `main` the gate reported five `bottom-bar` findings and the first card ending at 739px.
