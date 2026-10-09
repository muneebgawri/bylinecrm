# P1-UI-6 — One view bar for every list, on the new list API

**Package:** `apps/web`. **Spec:** issue #48; doc 48 FR-CRMS-UI-1 (data views) and FR-CRMS-UI-12
(mobile). Builds on P1-UI-2 (people/companies), P1-UI-4 (deals board + list) and P1-4a (list totals,
reading by id, related names on rows, bulk routes). **Standing rule:** no divergence — deals had their
own view picker and filter chips; there is now one of each.

## One set of list controls

- `lists/ViewBar.tsx` and `lists/ListToolbar.tsx` were cut out of `ListPage.tsx` and made generic over
  every record object. People, companies and deals render the same view tabs (with counts), the same
  view menu (update / save as new / share / delete), the same filter builder and sort editor (popover on
  a desktop, bottom sheet on a phone) and the same Export button.
- **Deleted:** `deals/ViewPicker.tsx` and `deals/FilterChips.tsx`. Deals' URL state now goes through
  `lists/useListState.ts` under the same names as every list (`view`, `filter`, `sort`, `q`);
  `DEALS_PARAMS` keeps only the deals page's own (`pipeline`, `show`, `create`).
- **The owner rule lives in one place:** `useFilterFields` drops the Owner field for a member whose
  role sees only their own records. Deals had this rule; people and companies did not. Now all three do.
- **Columns:** `listConfig.tsx` is the one column catalogue for all three objects; columns are API
  field names, so a column, a sort, a saved view's column and an export column are the same string.
  The deals _list_ rendering takes its columns from it (the Columns chooser appears with `show=list`
  on a desktop; the board's cards have no columns). A deal's stage and days in stage are the board's
  own columns, always drawn: the API has no `stageId`/`daysInStage` field a view could save.

## On the list API (P1-4a)

- **Names on rows:** person rows show `company.name` and `owner.name`, deals `company`, `pointOfContact`
  and `owner`, companies `owner`, straight from the row. **Deleted:** `useRecordNames` (one
  `GET /companies/:id` per distinct company on screen) and the table's "rows on screen" callback that
  only existed to feed it. The deals board and list no longer map owner ids through the members list.
- **Totals:** every list page carries `total` / `totalIsExact`. The desktop footer reads
  "Page 2 of 9 · 120 of 1,034 people" (pages loaded of pages in the set — the list still loads by
  cursor); past the API's cap, "10,000+" and "Page 2 of 200+". A phone shows "1,034 people" above the
  cards and keeps infinite scroll.
- **Tab counts, one way everywhere (architect review):** every view tab — people, companies and
  deals — shows its view's total from the same hook, `useViewCounts`: one `limit=1` list read per
  view, with "10,000+" when the API stops counting. A deals tab counts its view across all
  pipelines, as the view's filter defines it; the board's per-lane counts and sums are its own and
  unchanged. On people and companies the open tab takes its count from the page's own read (the same
  `total`), so it is not read twice.
- **Bulk:** assign owner and delete are one `POST …/bulk` request. **Deleted:** the client-side loop
  (`settleAll`, `BULK_CONCURRENCY` = 6 requests at a time). `bulkSummary` reads the per-record results:
  "Assigned 10 people · 2 already were", and "N not found or not yours to change" for refused rows —
  the API answers `not_found` for every refusal, so the notice claims nothing more. A request refused
  as a whole (an own-scoped member naming someone else) says nobody was changed.
- **Export a selection:** the bulk bar's "Export selected" sends `POST …/export.csv` with
  `{ filter: { and: [{ field: 'id', op: 'in', value: [...] }] } }` and the visible columns — one
  request, with the ids in the body because 500 ids do not fit in a URL. The toolbar's Export still
  exports the whole current view.
- **One request path:** `api/client.ts` gained `send()`, the one place a request leaves the app
  (credentials, CSRF on a mutating method, JSON or multipart). `request` and `requestFile` differ only
  in how they read the answer, so a POSTed export carries the CSRF header the same way as everything
  else. `lib/saveFile.ts` is the one browser download helper (it had been about to exist twice).

## Not in this package

- **Bulk "Move to stage"** on deals still sends one move per deal: P1-4a has no bulk move, and a
  move into won/lost needs a per-deal payload. Bulk moves to won/lost stay refused with the reason.
- **Typed client:** `api/types.ts` is still hand-mirrored (it gained `RecordPage`, the summaries and
  the bulk types); #45 replaces it with `openapi-typescript` output.
- **Overlap with #51:** the routes gate's fixtures (`apps/web/e2e/fixtures.ts`, `api.ts`) gained the
  embedded summaries and `total` on record pages — data only, no gate logic — because the API's
  shapes changed and the gate cannot stay green on fixtures the API no longer returns.

## Mobile (FR-CRMS-UI-12)

People and companies keep P1-UI-2/P1-UI-7's behaviour (bottom-sheet filter and sort, select mode
with a bottom action bar, 44px targets, 16px inputs, view tabs that scroll inside themselves) and add
a count above the cards ("36 people").

**The deals list on a phone moved onto the shared `CardList`** (coordinator, after #51 landed): the
page-local card and its inline stage select are deleted. A deal card is name, company and amount, the
stage badge and days in stage, and one "•••" menu (Open, Move to stage…). **Moving a deal on a phone
is the board's Move-to-stage sheet**, so there is one move UI on a phone. A long press or Select
chooses deals for the bulk bar. The menu is `DataTableChrome`'s row menu, now exported from
`packages/ui` as `RowActionsMenu`, so a row's actions are offered the same way everywhere.

## Found in the browser walk (127.0.0.1:3481, isolated DB, desktop and 375px, dark and light)

- A deal's close date read "Nov 30, 2026, 5:00 AM": the catalogue formatted a calendar date as an
  instant (and would show the 29th west of UTC). Close date and custom `date` fields now use
  `formatDay`; a test in `America/Los_Angeles` failed with the old formatter.
- Confirmed: tab counts ("All people 36", "Austin 12"), "Page 1 of 1 · 36 of 36 people", company names
  with zero `/companies` reads, bulk assign as exactly one `POST /people/bulk`, the deals list on the
  shared toolbar with catalogue columns; at 375px in both themes no table, no sideways scroll, no
  target under 44px, no input under 16px on people, deals list and board; the deal card's menu opens
  the Move-to-stage sheet.

## Tests

`lists/ListPage.spec.tsx` (+5): the footer total and a count on every tab (one `limit=1` read per
other view); "10,000+"; the company name from the row with zero `/companies` requests; a selection
deleted with exactly one `POST /people/bulk` and no `DELETE`; a selection exported with one POST whose
filter is `id in [...]`. `deals/DealsPage.spec.tsx` (rewritten 4, +3): deals render the shared tablist
and Filter button (no chips); Save as new view through the shared menu posts `object: 'opportunity'`
with columns and drives the board by `view=`; Clear in the filter panel drops the filter; no Owner
condition for an own-scoped member; assign owner on a selection is one bulk request with the summary
"Assigned 1 deal · 1 already was"; Export selected posts the ids; owners named from the deal.
