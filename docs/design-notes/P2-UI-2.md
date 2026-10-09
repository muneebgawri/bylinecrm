# P2-UI-2 — the template editor and mail settings

Issue #60. Doc 50 §C (the template editor), doc 48 FR-CRMS-3 (templates), FR-CRMS-7 (unsubscribe),
FR-CRMS-12 (postal address), FR-CRMS-UI-12 (a phone). Built on P2-4's API (`/templates`,
`/templates/variables`, `/templates/:id/preview`, `/settings/mail`); no API change.

## Routes

| Path                           | What                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `/w/:id/templates`             | The list: kind tabs, search, "New template", row menu       |
| `/w/:id/templates/:templateId` | The editor: subject + body + locked footer, and the preview |
| `/w/:id/settings/mail`         | Postal address, default sender name, unsubscribe notice     |

`paths.template` and `paths.settingsMail` are new, so the routes gate visits both (fixtures added in
`e2e/fixtures.ts`). The list and the editor are one lazy chunk; the editor's rich text is its own.

## One editor (`components/rich-text/RichTextEditor.tsx`)

Notes, task bodies, template bodies and template subjects are the same Tiptap editor with a
**profile**. P1-UI-3's `NoteEditor` became the `note` profile (unchanged behaviour; it is now a thin
wrapper so its lazy chunk boundary stays where it was):

| Profile    | Content                                                                                          | Links         |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------- |
| `note`     | headings, bold, italic, lists                                                                    | http, https   |
| `template` | exactly P2-4's subset — paragraphs, h2/h3, bold, italic, lists, line break — plus variable chips | https, mailto |
| `subject`  | one paragraph of text and variable chips; Enter does nothing                                     | none          |

StarterKit v3 bundles `link` and `underline`; the profiles turn StarterKit's link off and add the one
configured `Link`, so there is one link extension (the note editor previously had two).

## Variables are chips (`components/rich-text/variableNode.ts`)

A `variable` inline atom node storing `{ path }` — the node P2-4 validates and renders. It is never
text, so it cannot be half-deleted or mistyped. Two ways in, both through the picker, so a variable
always comes from the registry (`GET /templates/variables`, grouped Person / Company / Deal / Sender /
Custom fields):

- **"Insert variable"** inserts at the caret of the field last focused (subject or body).
- **Typing `{{`** in either field removes the braces and raises the editor event `variableTrigger`;
  the page opens the picker targeting that field. An editor event (subscribed in an effect) rather
  than an extension option, so the page's callback can change without rebuilding the editor.

The subject is stored as text with `{{path}}` tokens; `templates/subject.ts` is the only translation
between that and the editor's one-line document, and the two round-trip (tests).

## Saving

Explicit Save (button, or ⌘/Ctrl-S through the command registry — one shortcut mechanism). A PATCH
sends the `version` the editor loaded; `409 conflict` opens "Changed by someone else — Reload / Save as
copy". Reload refetches and remounts the editor from what is stored; Save as copy creates a new
template from the draft and opens it. No autosave in v1. Unsaved work is guarded: an in-app
navigation is blocked with a "Leave without saving?" dialog (`useBlocker`), and a reload or closed tab
gets the browser's own prompt (`beforeunload`). After a save the "saved" snapshot is what was sent,
not the server's echo, so the editor does not read as dirty because the server normalised the JSON.

Permission (FR-CRMS-UI-6): without `template:write`, or on an outreach template without
`outreach:write`, the editors are read-only, Save and Insert variable are not offered, and the reason
is shown. The API is the gate.

## Preview

"Preview as" a person (the shared `RecordPicker`, widened to accept a deal for the optional deal) →
`POST …/preview` → subject + the rendered HTML in an `<iframe srcdoc sandbox="">` (no `allow-scripts`,
no same-origin) + the resolution line: "All N variables resolve for Dana Reyes." or "2 of 6 variables
are empty for Dana Reyes: custom.lastHeadline, custom.lastOutlet." A missing postal address is said
on its own. An empty variable is highlighted in the preview with its path (`data-missing-variable`),
never blank. The iframe reads the design tokens from the page so it follows the theme.

**The API renders the saved template**, not the draft (P2-4's preview takes only `{ personId,
dealId }`), so while there are unsaved changes the pane says "The preview shows the saved version.
Save to see your changes." and re-renders after each save. "Send test to me" is a disabled
placeholder ("Sending arrives with P2-3"; also "Fill every variable first" when not sendable).

## Mail settings

A section of Settings that every member who reads records may open (read-only) and an admin may edit;
`SettingsLayout`'s sections now each declare the capability that shows them, so a non-admin sees only
Mail. The address is all-or-nothing (blank fields → `postalAddress: null`); with any field filled,
street, city, postal code and country are required (checked before sending, and the API's
`fieldErrors` land under each field). Countries are ISO 3166-1 codes named by the browser
(`lib/countries.ts`, `Intl.DisplayNames`), so no country name is spelled here.

## Phone (FR-CRMS-UI-12)

Edit and Preview become tabs; the variable picker and the kind selector are bottom sheets
(`ResponsivePanel`); the editor toolbar scrolls inside itself with 44px buttons; editor text is 16px.
The routes gate found three phone gaps, fixed at their source in the design system rather than per
page: `TabsTrigger` had no phone size (34px), the table's tab row allowed a 40px-wide tab ("All"),
and a template's name link inside its card was a 17px target (now a full-height 44px link). It also
found one colour-only link in running text (now underlined).

## Also

- `CREATE_PARAM` / `withCreate()` in `paths.ts`: the `?create=1` parameter was spelled four ways
  (inline in AppShell and TopBar, `get('create')`, `DEALS_PARAMS.create`); it now has one definition
  and those call sites use it. ⌘K gains "New template" and "Mail settings"; "+ Create" gains Template.
- `fieldErrorAt(error, path)` in `api/client.ts`: the API's message for one body path. Other forms
  still have their own one-line versions; folding them in is a follow-up, not done here.
- Test setup stubs `Range`/`Element.getClientRects` (ProseMirror measures the caret; jsdom has none).

## What later packages add

- **P2-3** wires "Send test to me" and 1:1 send through the same render.
- **P3** sequences pick outreach templates; the unsubscribe placeholder is resolved per recipient.
- The template list's "used by" column arrives with sequences.
