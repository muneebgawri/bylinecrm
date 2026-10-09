# P1-UI-2 — Data views: people and companies

**Package:** `apps/web` (+ two small `packages/ui` additions). **Spec:** doc 48 FR-CRMS-UI-1 (data
views) and FR-CRMS-UI-12 (mobile-responsive, usable on a phone — owner requirement 2026-10-09); the
approved mockup `docs/design/shell-mockup-v3.html` (People). **Issue:** #39. Built on P1-4 (filter
grammar, saved views, export, search), P1-UI-1 (shell, `DataTableChrome`, `BulkBar`), P1-UI-3 (record
drawer, prev/next) and P1-UI-4 (breakpoints, touch tokens, Dialog-as-sheet, Toast, `lib/filterParam.ts`).

## The list model

`/w/:id/people` and `/w/:id/companies` are one component (`lists/ListPage.tsx`) parameterised by object,
in a lazy chunk with the table and virtualiser. **State lives in the URL** (`lists/useListState.ts`):
`view` (a saved view's id), `filter` (the P1-4 grammar, base64url — the one encoder in
`lib/filterParam.ts`), `sort` (`field:asc,field:desc`, the API's spelling, ≤ `SORT_MAX_FIELDS`), `q`.
A link, a refresh and Back reproduce the list; the record drawer's `open` parameter rides alongside.

The query sent is exactly the URL's: a view's filter and sort are its defaults on the server, and an
inline one replaces it whole (P1-4's rule). Choosing a view drops the inline filter and sort.

**Pages, not page numbers.** The list API pages by cursor and returns no total, so the footer says
"120 shown · more as you scroll" rather than "Page 3 of 9", and view tabs carry no counts. Desktop: the
table asks for the next page when the virtualised window is within 15 rows of the end. Phone: the cards
ask when the end scrolls into view (IntersectionObserver). `useRecordPages` (an infinite query) is the
one reader for both.

## Desktop and tablet (≥ 768px)

The mockup's table in a card (`DataTableChrome`, which gained a free-form `footer` for cursor lists):
saved views as tabs, search, Filter, Sort, Columns, Export; TanStack Table for columns (order,
visibility and widths come from the view) and TanStack Virtual for rows. A header click sorts by that
column (asc → desc → none) by changing the URL — the loaded rows are never reordered locally. Row click
opens the record drawer; ⌘/Ctrl-click (or "Open" in the row menu) opens the full page with the loaded
ids in router state, which is what P1-UI-3's prev/next reads (`state.list.ids` — the same key, not a
parallel one). Row menu: Open, Open in panel, Assign owner…, Delete…. Selection raises the floating
`BulkBar`: Enrol in sequence (disabled: "Sequences arrive in Phase 3."), Assign owner, Delete.

**Columns are fields.** A column's id is the field name the API knows, so a column, a sort key, a saved
view's column and an export column are the same string. Labels come from the shared descriptors
(`STANDARD_FIELDS`), sortability likewise (`isSortable` — custom fields are not sortable in v1); this
package declares neither. The identity column (a person's name, a company's name) is always first and
cannot be hidden. Column changes (show/hide/reorder with up/down buttons — keyboard-complete; resize by
dragging the header edge) apply at once and are kept until the view is saved or another is chosen.

## Phone (< 768px) — FR-CRMS-UI-12

- **Stacked cards** (`lists/ListCards.tsx`): avatar, name, company (people) or domain (companies), one
  status (a person's owner, "No owner" in warning; a company's "Ideal customer"), when it last changed.
  The whole card is the target (≥ 64px tall). Tap opens the full-screen record.
- **Select mode:** a long press (500ms) or the Select button turns taps into choosing; the bulk bar is
  fixed to the bottom edge above the home indicator, full width.
- **Views** are a horizontally scrolling chip row — the row scrolls, the page never does.
- **Filter and Sort** open as bottom sheets: `components/ResponsivePanel.tsx` renders the same editor in a
  popover on desktop and in the design system's `Dialog` (a bottom sheet below 768px, P1-UI-4) on a phone,
  with the actions in a row a thumb reaches. The column chooser is desktop-only (cards have no columns).
- Search is a full-width 44px field; every control uses the touch tokens (`h-touch`, `min-h-touch`,
  `text-touch` = 16px so iOS does not zoom).
- One breakpoint: `BREAKPOINT_PX.mobile` / `useIsMobile()` from `packages/ui` (Tailwind `md`, kept in step
  by a spec). No component spells a width.

## The filter builder

`lib/filterModel.ts` is the model, pure and tested; `lists/FilterBuilder.tsx` renders it (its own chunk,
loaded when the filter opens). A tree of groups ("Match all" / "Match any"), nested to the grammar's
depth, over conditions `{ field, operator, value }`. Everything comes from the shared vocabulary: the
fields (standard + live custom, `filterableFields`), the operators a kind takes (`OPERATORS_BY_KIND`), the
value shape an operator needs (none / one / list / pair). Value inputs by kind: text and numbers typed;
dates and instants with native pickers (an instant is converted to ISO with the browser's offset once);
select/multiselect/boolean/owner from their fixed choices (checkboxes for lists); a company or point of
contact found by search (`RecordPicker`), never typed as an id; money typed in a currency's major units
and sent as minor units (`lib/money.ts`).

**Contract:** `toFilter(tree)` is the one conversion to the grammar. Incomplete conditions (no value, a
half-filled pair) and groups they leave empty are dropped — a half-typed row never narrows the list;
nothing left is no filter. `draftProblem` checks the grammar's structural limits before Apply, so the
API's `400` for depth or size cannot be reached from the UI. Golden tests hold one filter per kind to the
shapes the API's compiler accepts.

## Saved views

The view menu offers what the API would allow (FR-CRMS-UI-6): **Update "X"** when the view changed and
the member may change it (own with `view:save`, shared with `view:share`), **Save as new view…** (name,
"Share with the workspace" when `view:share`), **Share / Stop sharing** on the member's own view,
**Delete view…**. A save writes the effective filter, sort and columns, then opens the saved view with
no inline state left over. The hooks (`useViews`, `useCreateView`, `useUpdateView`, `useDeleteView`) and
the endpoint are P1-UI-4's — one definition; this package added `columns` to the create/patch bodies.

## Pickers

`components/RecordPicker.tsx` replaces P1-UI-3's company and point-of-contact selects, which loaded the
first 200 records and so could not offer the 201st. It searches (`GET /search`, debounced
`SEARCH_DEBOUNCE_MS` = 250ms, ≤ 10 hits) in a popover, or a sheet on a phone. The record pages' rails
(a company's people and deals, a person's deals) likewise now ask the API with a filter
(`records/related.ts`) instead of filtering a page of everything client-side, and show "200+" when
there is more.

## Export

`GET …/export.csv` with the list's view, filter, sort, search and the visible columns' export fields
(a person's Name column exports first and last name), fetched through the one client
(`requestFile`) so a refusal — `413` past `EXPORT_MAX_ROWS` — shows the API's words in a toast instead of
downloading an error page. Export of a _selection_ is not offered: the API cannot filter by id.

## Performance (FR-CRMS-UI-10)

The list route, TanStack Table/Virtual and the filter builder are lazy chunks; `Popover` is a subpath
export (`@bylinecrm/ui/popover`) so it loads with the pages that use it, not in every first paint. The
list-only query hooks live in `api/lists.ts`, not in `api/queries.ts` (which the shell imports). First
load after this package: 183.0 of 190 kB gzip.

## States (FR-CRMS-UI-7)

Skeleton rows while the first page loads; "No people match this view" (with Clear filters) when a filter
or search is on and nothing matches, versus "No people yet" (with Add person) when there is nothing at
all; "Couldn't load people" with the API's reason and Retry. Every outcome of an action (saved, assigned
N, deleted N, what was refused and why, an export refused) is a Toast.

## Known gaps — named, not worked around

1. **No total count.** `GET /people` and `/companies` return no total, so no "Page x of y" and no counts
   on view tabs. Owed to the API: a `count` (or `includeTotal`) on the list routes — group-by already
   counts, so the query exists.
2. **Company names on person rows.** A person row carries `companyId` only, and no route reads many
   records by id, so names are looked up one cached `GET /companies/:id` per distinct company **on
   screen** (`useRecordNames`, desktop: the virtualised window only; phone: loaded cards). One hook owns
   it; when the API takes `id in […]` as a filter (or embeds the company's name), only that hook changes.
3. **Bulk changes are one request per record**, `BULK_CONCURRENCY` (6) at a time; there is no bulk route.
   Refusals are collected and reported, not hidden.
4. **Import** is disabled with its reason (the importer is P4-4); **Enrol in sequence** is disabled
   ("Phase 3").
5. Deals keep P1-UI-4's own view picker and filter chips; folding them onto this package's view bar and
   filter builder is a follow-up (it would edit the deals route, which this package did not own).

## What #38's gate will check here

At 375px: no horizontal page scroll (the view chips and table scroll inside themselves); every
interactive element ≥ 44×44 (cards, chips, buttons via the touch tokens, the picker's options); inputs at
16px; the page's primary action (Add person/company) visible. At 768 and 1280: the table and toolbar.
Both themes; axe at WCAG 2.1 AA.

## Tests

`lib/filterModel.spec.ts` — fields, operators, golden filters per kind, dropping incomplete rows, round
trip, depth limit. `lists/ListPage.spec.tsx` — the URL filter and sort reach the API and rows render in a
table; Save as new view posts filter + sort + columns and opens the view; Update posts the change to the
member's own view; a 375px screen gets cards, not a table; the "match nothing" state.
`components/RecordPicker.spec.tsx` — three keystrokes, one debounced search request, choosing saves.
`packages/ui` — Popover (opens, Escape, focus return).
