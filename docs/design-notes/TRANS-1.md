# TRANS-1 — SMTP2Go as a second transport for the outreach pool (#209)

Spec: PROPOSAL-ownership-and-guardrails.md §7. Approved by the owner to build now. FR coverage: FR-CRMS-6 / -13 (the
pool's gate, rates and domain check apply unchanged), FR-CRMS-7 (suppression mirrored), FR-CRMS-8 (opens/clicks).

## What it is

A pool mailbox has a `transport`: `gmail` (as before) or `smtp2go`. An SMTP2Go mailbox sends the stored MIME through
SMTP2Go's HTTP API (`POST /v3/email/mime`, `X-Smtp2go-Api-Key`, `mime_email` base64) instead of the Gmail API. Nothing
else about the pool changes: the same claim (paused, domain verified, rolling-24h allowance with warm-up), rotation,
spacing, bounce/complaint pause rates.

## Never for 1:1 or personal mail

- `mailboxes_smtp2go_pool_only`: the database refuses `transport = 'smtp2go'` unless `purpose = 'pool'`.
- The composer's path (`preparePersonal`) already refuses pool mailboxes; the send job refuses again
  (`transport.pool_only`) any SMTP2Go delivery that is not outreach (no sequence enrolment, request not `outreach`).
- Every pool send was built by `prepareOutreach`, which passes the recipients through GUARD-1's `RecipientGuard`
  (`sequence_step` path); the suppression list is read again right before the SMTP2Go call, as for Gmail.

## Secrets

- The API key is sealed with `SecretBox` (`transport_key_ciphertext`), sent once by an admin, never returned by any route.
- The webhook is per mailbox: `POST /api/hooks/smtp2go/<mailboxId>`. SMTP2Go's documented webhook auth is an optional
  `Authorization` header (bearer or basic) set on the webhook; the CRM makes a random secret per mailbox
  (`hook_secret_ciphertext`, sealed) and shows the admin `Bearer <secret>` to paste into SMTP2Go. It is compared in
  constant time; a mismatch is `401`, an unknown mailbox `404`, both rate-limited per IP. Rotating makes a new one.
- Disconnecting (`DELETE /mailboxes/:id`) wipes key and secret; the hook then answers `404`.
- `mailboxes_credentials_by_status` replaces `mailboxes_refresh_token_by_status`: a Gmail mailbox holds a refresh
  token and no key; an SMTP2Go mailbox a key and hook secret and no Google token; a disconnected one no secret.

## Delivery and retries

SMTP2Go has no idempotency key and no lookup by our Message-ID, so the Gmail path's "look before resending" is not
available. The adapter classifies every failure:

| outcome       | when                                        | what the CRM does                                           |
| ------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `retry`       | no connection, `429`, `503`                 | `lastError = smtp2go.not_sent`, rethrow → the queue retries |
| `refused`     | other `4xx`, or `200` with `succeeded = 0`  | failed, `smtp2go.<error_code>`                              |
| `unconfirmed` | timeout after the request left, other `5xx` | failed, `smtp2go.unconfirmed`; never resent                 |

A job that finds the send already `sending` without `smtp2go.not_sent` (the worker died mid-request) also fails it as
`smtp2go.unconfirmed`. A person may retry a failed send by hand (#134) after checking SMTP2Go's activity.

After a send, the outbound row gets `provider_message_id = smtp2go:<email_id>` and our own Message-ID as
`provider_rfc822_message_id` (SMTP2Go sends the MIME as built). The message is stored through sync's one writer
(`MailSyncService.storeSent`, from `gmailShapeOf(mime)`), so it is linked to its send, threaded, on the timeline as
`email.sent` (which moves the sequence on), and a reply naming it is matched as any other.

## Replies stay ours

Mail sync never reads an SMTP2Go mailbox (tick filter and `syncMailbox` guard). Replies arrive in whichever mailbox
the message's Reply-To names (or the From domain's own inbox, if a Gmail mailbox there is connected); sync's existing
In-Reply-To / References matching on `mail_outbound.rfc822_message_id` recognises them.

## Webhook → existing tables

Each delivery is one event (JSON or form). It is matched to a **sent** send of **this mailbox** by
`smtp2go:<email_id>`, our `message-id`, or `X-BylineCRM-Id` (add that header in the webhook's "Email headers").
The event key is a hash of (email_id, message-id, event, rcpt, time, url), so a redelivery changes nothing.

| SMTP2Go event    | Writes                                                        | Events                                        | Then                                                                                |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `bounce`         | `mail_bounces` (`message_id` null, `provider_event_id`)       | `email.bounced`                               | hard: suppression `hard_bounce`/`provider`, bounce rate judged (existing consumer)  |
| `spam`           | suppression `complaint`/`provider` with the send              | `suppression.added`, `email.complained` (new) | complaint rate judged (existing consumer)                                           |
| `open` / `click` | `tracking_hits` (`token_id` null, `provider_event_id`, `url`) | `email.opened` / `email.clicked`              | same bot rule; stage rules as for our clicks                                        |
| `reject`         | send `sent` → `failed`, `last_error` `smtp2go.rejected`       | `email.failed`                                | the send job's one failure write (follow-ups called off; no longer counted as sent) |
| `unsubscribe`    | suppression `unsubscribe`/`provider` with the send            | `suppression.added`                           | enrolments stop, as for our own link; never lifted                                  |
| `delivered`      | send's `delivered_at` (first report kept)                     | —                                             | shown on the send (`deliveredAt`)                                                   |
| `processed`      | —                                                             | —                                             | `ignored`: the send is `sent` already                                               |
| `resubscribe`    | —                                                             | —                                             | `ignored`: an unsubscribe is never lifted, so the CRM does not mail it again        |
| anything else    | —                                                             | —                                             | `ignored`                                                                           |

Event names are the webhook's (`processed`, `delivered`, `open`, `click`, `bounce`, `spam`, `unsubscribe`,
`resubscribe`, `reject`); the activity API's past-tense names (`rejected`, `unsubscribed`, `opened`, `clicked`) are
read as the same events, and keyed as them, so either spelling redelivered changes nothing. A `reject` is SMTP2Go
refusing the message after taking the API call (an address on SMTP2Go's own suppressions, an unverified sender, a
sandboxed key): the CRM does not suppress the address for it, since the reason may be ours. A redelivered `reject`
finds the send already failed and is a `duplicate`; a redelivered `unsubscribe` finds the entry for the send; a
second `delivered` finds `delivered_at` set.

If the workspace's own short-link domain (P3-4) tracked the send, SMTP2Go's open/click is `ignored` so nothing counts
twice; turn SMTP2Go's open/click tracking off for those domains. Distinct-click counts use the token or, for SMTP2Go
hits, the URL. The mailbox records the last delivery's time and result (`recorded`, `duplicate`, `unmatched`,
`ignored`, `bad_secret`) for the settings page.

## Send test

`POST /w/:id/smtp2go/mailboxes/:mailboxId/test` (`workspace:admin`, `200`, at most 5 per mailbox per hour) sends one
message through the mailbox's key to the asking admin's own account address — our Message-ID, `X-BylineCRM-Id`, and a
link to this settings page for SMTP2Go's click tracking. It is a send of that mailbox (`mail_outbound.is_test`), so
SMTP2Go's events for it match as any send's and the card's last-event line shows them. It skips sequences and the
pool's gate (rotation, spacing, allowance) and is left out of the allowance, spacing and rate denominators — a test
never holds back a real send — but never skips the suppression list (`SendPolicy`). The answer is `sent`, or `refused`
with the suppression list's or SMTP2Go's reason (a refused test send is `failed`, as a real one would be). It is not
stored as a message: it is about no record.

## Domains

An SMTP2Go mailbox's domain is enrolled and gated like any pool domain. The SPF step passes `include:spf.smtp2go.com`
as well as Google's; the admin gives the DKIM selector SMTP2Go assigned (`s123456`) when adding the mailbox (or later
on the domain). DMARC is unchanged.

## API and UI

- `GET/POST /w/:id/smtp2go/mailboxes`, `PUT …/:mailboxId/api-key`, `POST …/:mailboxId/rotate-secret` — `workspace:admin`.
- `MailboxView.transport`; the mailbox otherwise appears in `/mailboxes` and the pool like any other.
- Settings › SMTP2Go (admin): add a pool mailbox (address, key, DKIM selector), copy the webhook URL and header, replace
  the key, rotate the secret.

## Assumptions to confirm against a live SMTP2Go account

- `/email/mime` takes `mime_email` base64 and answers `data.email_id`, `data.succeeded`.
- Custom headers chosen in the webhook arrive as fields named by the header; `time` is ISO-8601 or epoch seconds;
  a click's link arrives as `url` (or `link`). The parser accepts each.
