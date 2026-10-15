# CAL-1 — Google Calendar sync: meetings as KPIs, attendees as leads

**Owner request, 2026-10-15:** "users connect their Google Calendar as well so we can track Google meeting
events/bookings in the CRM as part of the employee's KPIs as well as save the attendees as clients/leads
assigned to that employee."

**Spec divergence, to be ruled on.** Doc 48 §2 lists "Calendar sync" among the v1 non-goals, and §4 skips the
ledger's `calendar` area. This package builds it on the owner's request; the mirror is not edited here. Asked of
the owner: record a D-ruling moving calendar sync into scope (and which FR it becomes), and have the ledger
author add `calendar` rows (PAR-015 already notes Twenty shows calendar events on records).

Depends on P2-1 (the workspace's OAuth client, `MailboxTokens`), P2-2 (the blocklist rule, address matching,
the sync/queue pattern), P1-3 (timeline), P1-2 (stage rules — `meeting.booked` was in the rule catalogue and
had no publisher until now) and P1-6 (outbox).

## Connecting: the personal mailbox's grant, one more scope

There is no second connection. A **personal** mailbox's connect now asks for
`calendar.events.readonly` beside `gmail.send` and `gmail.readonly` (`PERSONAL_MAILBOX_SCOPES`); a pool
mailbox's and Postmaster's are unchanged. The calendar scope is **optional**: `assessGrant` still requires
only Gmail's two, so a person who unticks the calendar on Google's consent screen keeps a working mailbox,
and calendar sync runs only while `granted_scopes` carries the scope (`calendarGranted`). A mailbox
connected before this package has no calendar until its owner picks **Connect calendar** (the same connect
again; the row and its mail are kept). Read-only events scope: never the calendar list, settings or a write.

Admin setup gains two steps (Settings → Google): allow the third scope on the consent screen, and turn on
the Google Calendar API in the Cloud project. A project without the API answers `403 accessNotConfigured`;
the run records `calendar_api_disabled` (an admin's step), not "reconnect".

## Data (migration `20261015090000_calendar_sync`)

Four tenant tables under RLS in P0-2's shape; `linked_object` gains `meeting`.

| Table                         | What                                                                                                                                                                                                                        | App role                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `calendar_events`             | A meeting, once per workspace, unique `(workspace_id, identity_key)`: iCalUID, plus the original start for one occurrence of a series. Title, location, Meet link, times, status, organiser, `host_member_id`, `booked_at`. | SELECT, INSERT, UPDATE         |
| `calendar_event_copies`       | One member's calendar's copy (unique `mailbox_id, provider_event_id` — sync's dedupe key), with that member's answer and whether they organised it.                                                                         | SELECT, INSERT, UPDATE         |
| `calendar_event_participants` | One attendee (unique `event_id, address`, lower case checked), matched to a person and a member; `lead_created_for_member_id` when sync created the person.                                                                 | SELECT, INSERT, UPDATE, DELETE |
| `calendar_sync_states`        | Per mailbox: status (`mail_sync_status`), last run's start, last full read of the window, last error.                                                                                                                       | SELECT, INSERT, UPDATE         |

A meeting's description is never read or stored.

## The run (`CalendarSyncService.syncCalendar`)

- **Window.** First run: the last 30 days and the next 60 (`CALENDAR_INITIAL_DAYS`, `CALENDAR_HORIZON_DAYS`),
  recurring meetings expanded one occurrence at a time (`singleEvents`), cancelled ones included. Later runs
  read only what changed since the previous run's start less 5 minutes (`updatedMin`), from 2 days back; once a
  day the whole window again, which is how occurrences of a series that come within the horizon are found.
  **Deviation from mail sync:** no Google sync token — it cannot be combined with a bounded window, and an
  unbounded recurring series cannot be expanded.
- **What counts.** A meeting with at least one outside attendee (`outsideAttendees`: not the owner, not a room
  or Google group/resource calendar, not a member's sign-in address or a workspace mailbox, not at any work
  domain the workspace's members or mailboxes use — free mail never counts as a work domain — and not covered
  by the blocklist that applies to the owner's mail), at most 25 on the invitation (`CALENDAR_MAX_ATTENDEES`:
  webinars and all-hands are not client meetings), not declined by the owner, of Google's `default` type (not
  out of office, focus time, working location, birthdays, Gmail's own bookings), and **not marked private or
  confidential** (the owner's own business — e.g. an interview elsewhere — never stored, never a lead, never
  shown to an admin).
- **Once per workspace.** The first calendar to hold a meeting creates it and announces it; a later calendar
  adds its copy. `host_member_id` (who it counts for as booked) is the member whose calendar stored it first,
  moved to the organiser when the organiser is a member whose calendar holds it.
- **Attendees.** Brought in line with each copy, except that only the **organiser's** copy removes attendees
  (a guest's calendar hides the other guests when the organiser turned guest visibility off), and a row that
  brought in a lead is never removed (the member's KPI keeps it).
- **Leads** (amended by CAL-3: only clear leads are made; the others are suggested). For a meeting that counts, each outside attendee who is no one in the CRM becomes a person through
  `PeopleService.createIn` — announced as `person.created` like any person (enrichment follows), actor
  `{ kind: 'sync', id: mailbox }`, source `Google Calendar`, owner the calendar's owner, company the workspace's
  company at their domain if there is one (none is created), name from the invitation's display name. An outside
  attendee who is a person nobody owns is given to the calendar's owner (`person.updated`). A person someone
  deleted is not brought back.
- **Cancelled.** Google reporting a copy cancelled makes that member's answer a "no"; the meeting is cancelled,
  and `meeting.cancelled` announced once, when no member's calendar still holds it with anything but a "no".
- **Failures.** `MailboxUnavailable` (Google refused the grant) and a withdrawn calendar scope (`403
insufficientPermissions` — the mailbox's `granted_scopes` drops the calendar scope, so the tick stops reading
  it and the page offers to connect it) are recorded and not retried; `429`/`5xx`/no answer are retried with
  mail sync's backoff (`CALENDAR_RETRY_ATTEMPTS`), then the job is retried by the queue.
- No Google call is made with a transaction open (the fake asserts it). Each meeting is one transaction, run in
  a job scope (`WorkspaceContext.run`) so the record services see their workspace; a unique-key race between two
  members' runs is retried once (`CALENDAR_STORE_ATTEMPTS`).

## Events, timeline, rules, webhooks

`meeting.booked` (when a meeting is first stored; `occurredAt` = when it was booked) and `meeting.cancelled`
carry `meeting` (a `MeetingSummary`, no description), `targets` (each outside person, their company, their open
deals) and `related` (people and companies). The timeline writes `linked-meeting.booked|cancelled` on every
target; the record page has a **Meetings** filter. `meeting.booked` drives the existing stage rule ("meeting
booked → Meeting"): note that the first read's past 30 days are announced too, so open deals move forward for
meetings already held (forward only, as every rule). Webhooks deliver both.

## Reading: meetings and KPIs

(CAL-3: every count below takes only meetings with a person outside the workspace whom the member owns; see
`CAL-3.md`.)

`GET /w/:id/meetings` (newest first; `from`, `to`, `memberId`) and `GET /w/:id/meetings/kpis?from&to` (at most
366 days), both `record:read`. An admin reads every member's (or one, `memberId`); anyone else their own — another
member's is `403`, and an API key without the admin role is `403`. KPIs per member over `[from, to)`:

- **booked** — meetings they host booked in the period, a recurring series once (distinct iCalUID);
- **held** / **upcoming** — distinct meetings starting in the period, before / after now, not cancelled, not
  declined by them (counted for every member who attended, so a meeting two reps held counts for both; one their
  calendar and Slotline both hold counts once — CAL-2);
- **cancelled** — meetings they host called off in the period;
- **peopleMet** — distinct outside people in their held meetings;
- **newLeads** — people calendar sync created for them, dated by the person's creation (an attendee row may be older than the lead it brought in), each once.

`GET /mailboxes/:id/calendar` (whether the grant reads it, the sync state) and `POST …/calendar/sync` (owner or
admin) mirror P2-2's mail sync routes.

## Web

**Team** (now open to every member with `record:read`; the API narrows it) shows the period's KPI tiles, a table
by member and the period's meetings with their people (new leads marked). **Mailboxes** gains a Calendar column
and **Connect calendar** / **Read calendar now** row actions; Settings → Google and the connect dialog say what
is asked for.

## Worker

`CALENDAR_SYNC_WORKER` (default `1`): a tick every 10 minutes queues every connected personal mailbox whose grant
carries the calendar scope; `mailbox.connected` queues one at once. The cross-tenant suite sets `0` and drives
runs against `FakeGoogleCalendar`.

## Known limits (follow-ups, not built)

- Admins see every member's external meetings (titles and outside attendees). Private/confidential events are
  excluded; anything else in a member's primary calendar with an outside guest is visible to admins. A team-lead
  scope (doc 13's `kpi:view_team`) does not exist in this CRM yet.
- ~~Personal meetings with outside guests and vendor pitches a member accepts produce leads~~ — **CAL-3**: only
  clear leads are made (someone at a work domain the member invited); the rest are suggested, and a meeting counts
  only once a person on it is the member's.
- Only the primary calendar is read. A meeting moved beyond the horizon, or edited more than 2 days after it
  started, keeps its last known time. A meeting made private after it was stored stays stored.
- **Connect calendar** is offered on a mailbox to its owner only: a connect signs in to the Google account of
  whoever starts it. (The existing **Reconnect** action has the same trait for an admin acting on another member's
  mailbox; unchanged here.)
- Attendees are not re-announced on the timeline when a person is created for an address later (attendees are
  re-matched; mail's `email.linked` has no meeting counterpart).
- The Team page lists the first 50 meetings of a period, no paging; KPI periods are the browser's local weeks
  and months, so an all-day meeting (stored at UTC midnight) can fall a day off at a boundary.
- The route gate's visual baselines for Team, Mailboxes and the record pages (the new filter chip) change and
  need regenerating on CI (`pnpm --filter @bylinecrm/ui visual:baseline`).
