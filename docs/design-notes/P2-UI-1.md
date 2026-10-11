# P2-UI-1 — Compose and threads on the record page

Issue #59. Doc 50 §A (the record page: the compose box at the top of the activity, the thread view),
doc 48 FR-CRMS-2/3/4 and FR-CRMS-UI-2/6/7/12, the record-drawer compose in mockup v3. Built on P2-2's
threads, P2-3's send and P2-5's scheduling. No API change.

## Where it sits

| Record  | Compose box                                         | Timeline                                         |
| ------- | --------------------------------------------------- | ------------------------------------------------ |
| Person  | Top of the activity column (and in the drawer)      | Email entries open the thread; sends show at top |
| Deal    | Same, to the deal's point of contact (`dealId` set) | Same                                             |
| Company | None: mail goes to a person                         | Email entries open the thread                    |

On a phone (FR-CRMS-UI-12) the inline box gives way to a **full-screen sheet** raised by the bottom bar's
**Email** (`RecordCompose`); the template and schedule pickers are sheets (`ResponsivePanel`). The person
page's primary action is now **Email** (Enrol stays, disabled, "Sequences arrive in Phase 3"); the deal
page adds Email beside Note and Task, disabled with its reason when there is no point of contact. `e` and
the palette: "Email this person" / "Email the point of contact". The palette (and the `?` sheet) now list the record's own
groups ("This record", "This panel") — they had none, so no record action appeared there; a palette
command runs after the palette has closed (`CommandDialog` `onCloseAutoFocus`), so focus it moves stays.

## The compose box (`routes/w/mail/Composer.tsx`, rules in `compose.ts`)

- **From** lists only the member's own **personal, connected** mailboxes (`ownSendingMailboxes`). Pool
  mailboxes, other members' and ones needing a reconnect never appear — the API refuses them anyway
  (403/409). With none: one line, "Connect a mailbox to email from here", and a link to Mailboxes.
  Without `email:send` (or `mailbox:read`) the box says why instead (FR-CRMS-UI-6).
- **To** is the person, always first; more people are added through the shared `RecordPicker` (it gained
  a `placeholder`). The request leaves `to` out unless someone was added (the API defaults to the person).
- **Subject** and **body** are the one `RichTextEditor`, profiles `subject` and `template` — exactly the
  API's template subset, so nothing the server refuses can be typed.
- **Templates**: personal only (`kind=personal`; outreach templates belong to sequences and the API
  refuses them for 1:1 mail). Picking one fills subject and body with variable chips and asks the
  server's preview (`POST /templates/:id/preview {personId, dealId}`) which variables are empty for this
  person. Empty chips turn red (a ProseMirror decoration, `MissingVariables` — never stored or sent), the
  footer names them ("custom.lastOutlet is empty for Dana Reyes · Send is disabled") and Send and
  Schedule are disabled. A send refused with `422 unprocessable` marks the variables it names the same
  way (the person's data can change between preview and send).
- **Template or written.** The API takes `templateId` **or** `subject`+`body`. A template left exactly as
  filled is sent as the template (so the send is attributed to it); once edited it is sent as written.
  A reply is always written: with no subject it takes the parent's `Re:` on the server.
- Chips come only from templates: the composer offers no "insert variable" (1:1 mail is written to a
  known person), so `{{` is just typed there — `Variable.configure({ trigger })` turns the `{{` rule on
  only for an editor whose owner has a picker (the template editor). Every chip on screen is therefore
  one the preview resolved for this person.
- **Schedule** (`SchedulePicker`): a `datetime-local` in the sender's zone, which it names, and
  "Recipient's zone unknown" (`recipientTimeZone` is always null until Phase 3; never guessed). The
  minimum lead and horizon are `MAIL_SEND_MIN_LEAD_SECONDS` / `MAIL_SEND_HORIZON_DAYS` from
  `@bylinecrm/shared` (`scheduleProblem`), checked before the request; the API's `400` is shown too.
  The request sends the instant (`toISOString()`) and `timeZone`.

## A send on the timeline (`routes/w/mail/sends.ts`, `SendStatus.tsx`)

`POST /mail/send` answers `202` before anything is on a record, so the client keeps what it sent: the
tab's sends live in the query cache (`keys.mailSession`, never fetched). The timeline merges them, plus
the server's scheduled sends for this record (`GET /mail/scheduled?limit=100`, so a reload still shows
them), at the top of the list:

- **Sending…** → **Sent**: `GET /mail/messages/:id` is polled with backoff (1s, 2s, 4s … 15s,
  `outboundPollMs`) until final — and, once sent, until its stored copy exists (`mailMessageId`). The
  timelines are re-read when it is sent and again when stored; the "Sent" line gives way to the stored
  message's own entry (matched by `linked.id`).
- **Failed**: the API's reason (for `unsendable`, the variables it names) and **Retry**, which sends the
  same request again and replaces the line.
- **Scheduled for Mon 12 Oct, 09:00 (Europe/London)**: in the zone it was scheduled in, with
  **Reschedule** (`PATCH`, same picker) and **Cancel send** (confirmed in the page; `POST …/cancel`).
  Cancelled sends leave the list.

An Emails chip joins the timeline filters (`kinds=linked-email`), and stored mail reads as
"dana@acme.com wrote “Intro”" / "Kate Morgan sent “Intro”" (`timeline-items.ts` had read it as
"added email"); the line links to its thread.

## The thread view (`ThreadDrawerHost`, `ThreadView`)

`?thread=<id>` opens it over whatever is showing — the record page or the record drawer (Radix stacks
them; Esc closes the top one) — so a refresh or a shared link lands on the same view. The drawer is
560px on a desktop and the full screen on a phone; its chunk loads only when the param is present.

- Messages run oldest → newest, each with sender, time, subject and To/Cc lines.
- A readable body is the API's sanitised HTML in `components/EmailFrame.tsx` — the template preview's
  frame, moved there so there is one: `sandbox` never includes `allow-scripts`, and the document carries
  a CSP that loads nothing. Thread messages use `fit`: `allow-same-origin` (no scripts) so the page can
  size the frame to its content, and the page opens the body's `https:`/`mailto:` links in a new tab with
  `noopener,noreferrer` — a message can never navigate the frame or the app. Plain-text-only messages
  are shown as text.
- A message in another member's personal mailbox (`bodiesVisible: false`) shows subject and
  participants with "Body hidden — personal mailbox", and no Reply.
- **Reply** answers the newest message, from the thread's own mailbox (the API's rule; if it is not one
  of the member's connected mailboxes the composer says so), to the person on the other side (the
  sender of inbound mail, else the first CRM person it went to), with `replyToMessageId`.

## One of each

`EmailFrame` (template preview + threads), `RichTextEditor` (+ `missingVariables`), `RecordPicker`,
`ResponsivePanel`, `ConfirmDialog`, `fieldErrorAt`/`failureText`. Mail hooks live in `api/mail.ts` (loaded
with the record chunk, not every page — initial JS stays under its budget); their keys are in `keys`.
`@tiptap/pm` became a direct dependency of `web` (it was already in the tree via Tiptap) for the
decoration plugin.

## Not exercised live

There is no real Google mailbox in the local stack and the API has no dev seeding path for mail, so the
composer, sends and threads were built against the typed contract with mocked fetches (unit specs) and
fixtures (routes gate, browser walk). The real-Gmail round trip was proven on the API side in the
P2-2/P2-3 test (matt@ ↔ outreach@, 2026-10-11).
