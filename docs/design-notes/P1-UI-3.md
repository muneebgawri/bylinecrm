# P1-UI-3 — Record pages: person, company, deal (drawer + full page)

**Package:** `apps/web`. **Spec:** doc 50 §A (record page), the approved mockup `docs/design/shell-mockup-v3.html`
(record drawer and structure), FR-CRMS-UI-2/4/6/7/8/10. **Issue:** #32. Conventions: P1-UI-1's design note.

## Routes and the drawer

- Full pages: `/w/:id/people/:personId`, `/companies/:companyId`, `/deals/:dealId` — one lazy `RecordPages` chunk
  (the three records share their panels), each with its route `errorElement`.
- **Drawer** over any workspace page: `?open=<object>:<uuid>` (the API's own `type:id` spelling, parsed once in
  `records/targets.ts`). A list row, a palette result or a shared link all land on the same panel and a refresh keeps
  it. `RecordDrawerHost` is mounted once in `AppShell` (lazy, so nothing loads until a drawer is asked for); Esc or the
  scrim removes the param; "Open full page" goes to the route. Same components, `layout: 'drawer'` stacks the columns.
- **Prev/next** follow the list the page was opened from: a list navigates with `state: { list: { ids } }`
  (`records/siblings.ts`); nothing is fetched to find neighbours. A page opened from a link has no arrows. The list
  pages (P1-UI-2) pass the state.
- **Not found, never forbidden:** a record outside the caller's owner scope answers `404` from the API, and the page
  says "Not found" — the route boundary on a full page, the panel in the drawer.

## The page (doc 50 §A, mockup v3)

Header (avatar initials, name, one-line summary with the company link, status pill, actions) → `FactGrid` → three
columns: **properties** (standard fields, then the workspace's custom fields from their definitions, then audit
stamps), **centre** (a designed compose placeholder on people — "Connect a mailbox to email from here", no fake
inputs — then the activity), **rail** (company / people / deals, tasks, notes, files). Company pages have no compose
box and their activity merges their people's entries (the API does the merge; each row is tagged with its origin).
"Enrol in sequence" is rendered disabled with the reason "Sequences arrive in Phase 3".

## Inline edit — the contract (`records/InlineEdit.tsx`)

A value reads as text; click or Enter edits; **Enter saves, Esc reverts, blur saves when changed**. The new value shows
at once; a refused save puts the old one back and shows the API's field error under the field (`messageFor` matches
`ApiError.fieldErrors` by path, including `custom.<key>`). Clearing a field sends `null`, never `""`. A reader without
the capability sees plain text with the reason in its tooltip — never a control that then refuses (FR-CRMS-UI-6). The
cache side is `usePatchRecord`: optimistic `setQueryData`, rollback on error, the returned record on success, list
queries invalidated. Custom fields pick their control from the definition's type (select/boolean → select; number,
date, url, email, phone → typed text; multiselect → comma list).

The **owner** is a picker over `GET /members/summary`; an own-scoped member (`recordScope: 'own'`) cannot hand a
record to someone else, and the control says why.

## Deal stage — live, no flag

P1-2 landed while this package was in progress, so the stage bar is built against the real API with no feature flag:
`StageProgress` from `GET /pipelines/:id` (stages sorted by position) and the deal's `stageId`/`daysInStage`/`closedAt`;
a "Move to …" row under it (`deal:move`) calls `POST /opportunities/:id/move`. Moving into a **won** or **lost** stage
opens a dialog for the close payload the API requires (won amount, or lost reason) before anything moves. After a
backward move the API returns the rules that may move it forward again, and the page says so. The rail shows the
stage history (`GET /opportunities/:id/history`), named through the pipeline the page already holds. Stage-move
timeline entries carry ids in `properties.stage`; names come from the same pipeline.

## One of each

`lib/money.ts` is the one money formatter (minor units + ISO currency; the minor digits are read from
`Intl.NumberFormat`, so JPY and BHD are right). `lib/format.ts` holds the date/relative/byte formatters (settings'
`formatDate` now re-exports it). `records/fields.ts` is the one map from API field name to the words a reader sees —
the properties column and the timeline's "changed" chips both read it. `records/timeline-items.ts` is the one
translation of a timeline `kind` + actor into a sentence. The API client (`api/client.ts`) gained multipart support
for uploads; it is still the only `fetch`.

## Notes, tasks, files

- **Notes:** the rail card lists them (rendered by `RichTextView`, which renders the editor's node types without
  loading the editor); "+ Add note", a note's Edit and the `n` key open the **Tiptap** editor (StarterKit with
  headings 2–3, bold, italic, lists, links; code blocks, quotes and rules off). The editor is its own chunk — 125 kB
  gzip — loaded only when someone starts writing; the initial bundle stays at 187.9 / 190 kB. Links are set through an
  inline form (no `prompt()`), and only `http(s)` hrefs are accepted or rendered.
- **Tasks:** dialog with title, status, due (local date-time → ISO), assignee picker; delete asks in the dialog.
- **Files:** drop zone + picker, list with download links (same-origin content URL with the session cookie), delete
  asked in place. Size and type limits are the API's; its refusal is shown as it says it.

## Keyboard (FR-CRMS-UI-4/8)

Registered in the palette registry under "This record" so `?` lists them: `n` note, `t` task, `o` focus the owner
picker, `e` (people) explains that mail arrives in Phase 2, `alt+[` / `alt+]` previous/next (the shell already owns
`[` for the sidebar). Dialogs and the drawer trap and return focus (Radix).

## States (FR-CRMS-UI-7)

`RecordSkeleton` matches the layout (no shift); an empty timeline prompts the first action; a timeline that fails while
the record loaded shows a muted strip with Retry (**partial** state); rail cards say "could not be loaded" or "No …
yet" in words; route errors use the shell's `RouteError`.

## Not in this slice

The list pages that open records and pass prev/next state (P1-UI-2) and the pipeline board (P1-UI-4); mail compose and
threads (Phase 2); sequences (Phase 3); editing additional emails/phones, address fields beyond city, and avatars (the
profile route owed from P1-1b); custom-field definition management (settings).
