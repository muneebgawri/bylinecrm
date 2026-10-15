# CAL-2 — Slotline bookings: the booking site's meetings as members' KPIs and leads

**Owner request, 2026-10-15:** "Apart from getting meetings from Google Calendar directly, we need to fetch from
our own booking web application (cal.diy fork): github.com/muneebgawri/slotline, deployed to
bookings.pinionpartners.co."

Builds on CAL-1 (the meeting store, KPIs, Team page). Slotline is a Cal.com community fork; nothing in its code
changes for this — it already delivers signed webhooks, and an instance admin can make one that fires for every
booking on the site.

## How bookings arrive

**A webhook, not polling.** Slotline posts a signed delivery the moment a booking is created, requested,
rescheduled, cancelled or rejected. Its API reads one user's bookings per API key, so polling would need every
member's key; one instance-wide webhook needs nothing from them.

- **Setup (Settings → Slotline, admin):** the booking site's address (an https origin; for links to a booking)
  and the secret entered on the webhook in Slotline (≥ 16 characters, held with `SecretBox`). The CRM makes the
  hook URL `APP_URL/api/hooks/slotline/<token>`: 32 random bytes, looked up by SHA-256 and held encrypted so the
  page can show it again; **New hook URL** replaces it (the old one is `404` at once). In Slotline the instance
  admin opens `/settings/developer/webhooks/new?platform=true` (a webhook for every booking), pastes the URL and
  the secret, and subscribes to `BOOKING_CREATED`, `BOOKING_REQUESTED`, `BOOKING_RESCHEDULED`,
  `BOOKING_CANCELLED`, `BOOKING_REJECTED`. Each member adding the same webhook under their own settings works too.
- **The hook (`POST /api/hooks/slotline/:token`, public, rate-limited per IP):** unknown token → `404`; the body's
  hex HMAC-SHA256 with the secret must equal `X-Cal-Signature-256` (checked over the raw bytes — the JSON parser
  keeps them only under `/api/hooks/` — in constant time) or `401` and nothing is read. A ping, or a trigger the
  CRM does not read, is acknowledged (`200`).
- **The organiser is the member:** by sign-in address, else by a connected personal mailbox's address (Slotline
  accounts often use the work mailbox). A member who has left, or no member at all: `200 unmatched`, counted on
  the settings page with the last such address, nothing stored.

## What a booking becomes

`parseSlotlineDelivery` turns the delivery into the same `ParsedMeeting` a Google event becomes, and
`MeetingStore` — now the one writer for both sources (moved out of `CalendarSyncService`) — applies CAL-1's rules
unchanged: kept when someone outside the workspace booked it, the booker and their guests leads the organiser
owns (source `Slotline`), `meeting.booked` once, the stage rule, the timeline ("booked … on Slotline").

- **One meeting with its Google event.** Slotline writes the booking into the organiser's Google Calendar with the
  booking's iCalendar UID, and that UID is the meeting's identity in both sources. Whichever arrives first creates
  the meeting; the other adds its copy. A copy now has a `source`: a Google copy is keyed by mailbox and Google's
  id, a Slotline copy (no mailbox — the database checks) by the UID, once per workspace. The meeting is marked
  `booked_via = slotline` and keeps the booking's current uid for a link (`<site>/booking/<uid>`).
- **Reschedule** keeps the UID, so it moves the meeting. A booking with no UID (not seen in Slotline's code, kept
  for safety) is keyed `slotline:<uid>`, and its reschedule calls the old key off.
- **Requested** (needs confirmation) is `tentative`; it counts as booked and to come.
- **Cancelled / rejected is Slotline's word:** the meeting is cancelled at once, whatever the calendars still
  show, and a Google copy can never reopen a meeting booked through Slotline (the Google event may linger a moment
  after the booking is cancelled). Only a Slotline delivery reopens one. A cancellation of a booking only a calendar
  held (made before the hook was set up) cancels it by its UID.
- Never stored: the booking's description, notes or answers to its questions.

## KPIs

`held` and `upcoming` now count **distinct meetings** per member: a meeting both their Google Calendar and
Slotline hold counts once. New: `bookedViaSlotline` — of the meetings booked, those booked through Slotline. The
Team page shows it as a column and links each Slotline meeting to its booking.

## Data (migration `20261015120000_slotline_bookings`)

`meeting_source` enum; `calendar_event_copies.source` (+ CHECK: a mailbox exactly for Google copies; partial unique
`(workspace_id, provider_event_id)` for Slotline copies); `calendar_events.booked_via`, `slotline_uid`;
`slotline_settings` (one per workspace, RLS in P0-2's shape; the hook reads only the token → workspace mapping
through the owner client, as the tracking routes do).

## Known limits

- **No retry from Slotline.** Its webhook sender does not retry a failed delivery, so a booking made while the CRM
  is down is missed until a Google Calendar read finds the event Slotline wrote (when the organiser's calendar is
  connected). A reconciliation from Slotline's API is a follow-up; it needs an API key per member, or an admin
  route in Slotline.
- **No replay window.** The signature has no timestamp; a replayed delivery is harmless (every write is idempotent),
  but an old cancellation replayed after a re-booking with the same UID would cancel it. Slotline gives a reschedule
  the old UID and a new booking a new one, so this needs the secret and a captured delivery.
- The NewswireOS `meeting_bookings` mirror (doc 13, D-22) reads Slotline separately; this does not replace it.
- Route-gate baselines: `settingsSlotline` is a new state and needs a baseline (`pnpm --filter @bylinecrm/ui
visual:baseline`), as do Team and Mailboxes from CAL-1.
