# REP-2 — Compose lint, recipient quality gate, kill switches, one-click unsubscribe (#205, FR-CRMS-24)

Spec: PROPOSAL-ownership-and-guardrails.md §6 items 5–9. Builds on REP-1 (#204: `reputation_settings`, the
reputation guardrail events, `ReputationGate` / `ReputationMonitor`, `guardrail_alert`), so this branch is based on
`claude/rep-1`.

## Compose lint (warn, never block)

`lintCompose` in `packages/shared/src/compose-lint.ts`, run client-side by the composer on every edit and shown
under the editor ("Deliverability warnings"):

| Code                  | When                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `spam_words`          | a phrase from `SPAM_TRIGGER_PHRASES` ("act now", "click here", "guaranteed", …) in subject or body            |
| `caps_subject`        | a subject of ≥ 6 letters, all upper case                                                                      |
| `link_only`           | a link and fewer than 5 words of the message's own text                                                       |
| `too_many_links`      | more than 3 links (marked or bare URLs)                                                                       |
| `image_heavy`         | fewer than 50 words of text per image                                                                         |
| `missing_unsubscribe` | a new message (not a reply) to a person whose `source` is not `manual`, with no "unsubscribe"/"opt out" in it |

## Recipient quality gate (pool sends)

`ReputationGate.assertRecipientQuality`, from `MailSendService.prepareOutreach` after the recipient guard, i.e. at
every sequence step's send time. It asks verification (FR-CRMS-16), which verifies just in time when the stored
answer is missing or stale:

- `invalid` (no domain / MX, disposable) or still `unknown` → `422 recipient.low_quality`, `recipient_quality` /
  `blocked` event; the step is held (the enrolment screen and step runner already refuse these earlier — this is
  the last line).
- `risky` (role accounts such as `info@`, catch-alls) → sent, `recipient_quality` / `warned` event, once per address
  per day.

Risky _domains_ are what the verifier reports (disposable = invalid); a workspace-maintained risky-domain list is
not built.

## Reply-rate floor

`ReputationMonitor` after each sync: replies (an inbound message from a non-member later in the thread) over
new-thread messages that left the mailbox (CRM or Gmail) in the last `replyRateWindowDays`, counted from the
mailbox's last resume if later. Under `replyRateFloorBps` on at least `replyRateMinSends` sends → the mailbox is
paused (`pause_reason.code = reply_rate`, `mailbox.paused` event), a `reply_rate` / `blocked` / high guardrail event,
and a `guardrail_alert` to the owner and every reviewer (admins + `guardrail:review`).

A paused **personal** mailbox still sends replies; new-thread mail is refused (`422 mailbox.paused`, a guardrail
event). A paused **pool** mailbox sends nothing (P3-2's claim). Pool mailboxes on SMTP2Go have no sync, so the floor
is not judged for them.

## Spam-rate kill switch

`SendingPoolService.evaluateDomain` (each Postmaster reading):

- ≥ `spamWarnBps` (0.1%) → `spam_rate` / `warned` event, admins + reviewers alerted, once per domain per day.
- ≥ min(pool `complaintPauseBps`, `spamPauseBps`) → pool mailboxes on the domain paused (as before), `spam_rate` /
  `blocked` event, alert.
- ≥ `spamPauseBps` (0.3%, Google's line) → every personal mailbox on the domain is paused for new recipients too
  (`domain_spam_rate`).

## Manual resume

`GET /reputation/paused-mailboxes`, `POST /reputation/paused-mailboxes/:id/resume { note }` — `guardrail:review`
(managers, admins). Settings → Guardrails lists paused mailboxes with a Resume button. P3-2's admin pool resume
still works.

## One-click unsubscribe (RFC 8058)

Outreach already carried `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (P3-1). REP-2 adds
them to every personal message that **starts a thread** (sent now or at a scheduled send's time), for its first
`to` recipient. The URL holds a 32-byte random token whose SHA-256 is stored (unforgeable, single address); the
existing `POST /api/unsubscribe/:token` suppresses the address (`unsubscribe` reason). Replies carry no header and
no footer link is added to personal mail.

## Defaults

| Setting               | Default   | Bounds           |
| --------------------- | --------- | ---------------- |
| `replyRateFloorBps`   | 100 (1%)  | 0–10000          |
| `replyRateMinSends`   | 50        | 1–10000          |
| `replyRateWindowDays` | 7         | 1–90             |
| `spamPauseBps`        | 30 (0.3%) | 1–10000          |
| `spamWarnBps`         | 10 (0.1%) | 1–10000, ≤ pause |

## Tests

`apps/web/src/routes/w/mail/composeLint.spec.ts`; `apps/api/test/cross-tenant/reputation.spec.ts` (REP-2 cases:
headers + one-click suppression, quality gate, reply-rate pause and resume, spam warn/kill switch, all
cross-workspace); `suppression.spec.ts` and `sending-pool.spec.ts` updated for the two intended behaviour changes
(personal mail headers; personal domain at the kill switch pauses).
