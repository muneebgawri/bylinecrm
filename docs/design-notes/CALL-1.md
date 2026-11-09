# CALL-1 — Calls with Quo: dialer and call notes

Owner ask (2026-11-08): a dialer and a notepad like Salesloft's. Provider: Quo (formerly OpenPhone). Quo has no
browser SDK and cannot place a call through its API, so the CRM drives the Quo app and owns the log.

## How a call flows

1. **Call** on a person (`apps/web/src/routes/w/records/CallPanel.tsx`): opens the Call panel — a running clock,
   the outcome (`CALL_DISPOSITIONS`: connected, left voicemail, no answer, busy, wrong number, call back later,
   not interested) and a rich-text notepad — and "Call in Quo" opens `tel:<E.164>`, which the Quo desktop app
   handles once it is the computer's calling app (Quo: Settings → Calls → default calling app). The person's
   `Phone` becomes E.164 with `e164Of` (`CALLING_CODE_BY_COUNTRY` in `@bylinecrm/shared`).
2. **Save call** → `POST /calls`: a `calls` row (`provider` manual, `status` logged), the note as a `Call notes`
   note on the person, and `call.logged` → `linked-call.logged` on the person's timeline.
3. **Quo's report** → `POST /api/w/:ws/inbound/quo` (`QuoHookService`): the delivery is verified
   Standard-Webhooks style (`webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 over
   `id.timestamp.body` with the `whsec_` key; five-minute tolerance), then the call is read whole from Quo's API
   (`GET /calls/{id}?include=summary,voicemail`, the delivery itself carries no participants). The person is the
   outside number's — a person whose stored phones end in its last nine digits, and only when exactly one does;
   the member is the Quo user's (`workspace_members.quo_user_id`). A manual log of the same direction to the same
   person within `CALL_MATCH_WINDOW_MS` (30 min) is the same call: claimed (`provider` quo, `externalId` set), the
   member's outcome and note kept. Otherwise a new row and `call.logged`. Every later event — recording, voicemail,
   summary, transcript — updates the row and leaves `call.updated`.

## Settings → Quo (admins)

`PUT /integrations/quo {apiKey}`: the key is checked against `GET /users`, the receiver registered as a webhook at
Quo (events `call.completed`, `call.missed`, `call.voicemail.completed`, `call.recording.completed`,
`call.summary.completed`, `call.transcript.completed`; `resourceIds: ["*"]`), the webhook's key and the API key
sealed, and members matched to Quo users by email. "Match again" re-runs the match; unlinking deletes the webhook
at Quo and forgets the key. Calls already in stay.

## Data

`quo_settings` (one per workspace), `calls` (RLS; unique per workspace, provider, external id), enum values
`call_direction`, `call_status`, `call_disposition`, `linked_object.call`. Migration
`20261120090000_call_1_quo`; no backfill.

## Not in this slice

Inbound-call screen pop (Quo sends `call.ringing`; the CRM could open the caller's record), click-to-SMS, a calls
report, and local-presence numbers (Quo's numbers are per user). Quo's API is 10 req/s per key; a burst of
deliveries is absorbed by Quo's own retries (each redelivery is idempotent here).
