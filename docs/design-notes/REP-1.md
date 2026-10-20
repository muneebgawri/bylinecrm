# REP-1 — Sender-reputation budgets and repetition detection (#204, FR-CRMS-23)

Spec: PROPOSAL-ownership-and-guardrails.md §6 items 1–4 and 10. Builds on the sending pool (P3-2: daily cap,
warm-up ramp, bounce/complaint pause), GUARD-1's `guardrail_events` and the Guardrails page, and Gmail sync.

## What it does

| Rule                                                                       | CRM send (enforced before it leaves)                                                                                                                                                                                                                                                                                            | Gmail sync (measured — it already left)         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Daily new-recipient budget, personal mailbox                               | `422 mailbox.budget_reached` (`details.window = day`), event `send_budget` / `blocked`                                                                                                                                                                                                                                          | `volume_anomaly` / `warned`, medium             |
| Hourly new-recipient budget, personal mailbox                              | `422 mailbox.budget_reached` (`window = hour`)                                                                                                                                                                                                                                                                                  | —                                               |
| Pool mailbox hourly cap (beside P3-2's daily cap + warm-up)                | claim refused `mailbox.cap_reached` → step rescheduled; event `send_budget` / `deferred`, path `pool_send`                                                                                                                                                                                                                      | —                                               |
| Near-identical bodies (simhash) to distinct recipients, outside a sequence | `422 message.bulk_pattern` ("use a sequence from the pool"), event `bulk_pattern` / `blocked`, high                                                                                                                                                                                                                             | `bulk_pattern` / `warned`, high                 |
| One normalised subject to distinct new recipients                          | **warns** (decision 2026-10-20): the send goes; `subject_repeat` / `warned` event once per mailbox per day, the sender told in the bell                                                                                                                                                                                         | `subject_repeat` / `warned`, medium             |
| Primary-domain protection (on by default)                                  | the primary domain is an admin's override or, if none, **derived**: the domain most current members sign in with (ties alphabetical). Pool claim refuses a mailbox on it (`mailbox.primary_domain`), `pick` skips it; enrolment refused while every connected pool mailbox is on it (an empty pool refuses nothing; steps wait) | —                                               |
| "unsubscribe" / "remove me" replies                                        | —                                                                                                                                                                                                                                                                                                                               | `negative_reply` / `warned`, low, one per reply |

"New recipient" = a recipient of a message that **starts a thread** (no `replyToMessageId` in the CRM, no
`In-Reply-To` from sync). Replies are never judged or counted. Budgets count **distinct addresses** in the window,
across CRM sends (`mail_outbound` queued/sending/sent) and mail sync saw leave the mailbox that the CRM did not send
(so a budget spent in Gmail is spent in the CRM too). Workspace members are not counted on synced mail.

A scheduled send is judged at its time, not at its request (the day it counts against is not known before).

## Defaults (per workspace; `reputation_settings`, Settings → Guardrails → Sender reputation)

| Setting                  | Default       | Bounds         | Why                                                                                                                           |
| ------------------------ | ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `dailyNewRecipients`     | 50            | 1–2000         | Industry norm for one inbox's cold mail is 50–100/day; Google's hard limit (2,000) is far past where reputation suffers.      |
| `hourlyNewRecipients`    | 20            | 1–500, ≤ daily | Spreads a day's budget; bursts look automated.                                                                                |
| `poolHourlyCap`          | 12            | 1–500          | Matches the pool's 60–300 s jitter (~12–60/h); stops a backlog draining in one hour.                                          |
| `nearDuplicateThreshold` | 10            | 2–1000         | Spec: the 11th near-identical 1:1 message of the day is refused.                                                              |
| `nearDuplicateDistance`  | 3 bits of 64  | 0–16           | Spec; templated mail with names/links/numbers swapped lands within 0–3 bits.                                                  |
| `subjectRepeatThreshold` | 10            | 2–1000         | Spec; kept separate from the body rule so each is tunable.                                                                    |
| `primaryDomain`          | null (derive) | a domain       | Override of the derived primary domain (members' sign-in domain); `effectivePrimaryDomain` in the API shows the one in force. |

Reading the thresholds needs `guardrail:review`; changing them `workspace:admin`.

## Fingerprints

`apps/api/src/reputation/fingerprint.ts`. The body is normalised — quoted text (`>` lines, "On … wrote:",
forwarded headers), signature (`-- `, or a sign-off line like "Best,") and the greeting line dropped; URLs,
addresses and numbers removed; lower-cased letters only — then a 64-bit Charikar simhash over words and word
pairs (FNV-1a 64) is taken. Stored signed in `bigint` columns: `mail_outbound.body_simhash` / `subject_key` as a
send is built, and `mail_messages.body_simhash` / `subject_key` filled lazily the first time a synced outbound
message is judged (the app role gets `UPDATE` on those two columns only; a message's content stays immutable).

## Where it runs

- `ReputationGate.assertPersonalSend` — from `MailSendService.preparePersonal` after the recipient guard, for a
  non-reply sent now or at a scheduled send's time.
- `SendingPoolService.claim` / `pick` — hourly cap and primary domain; `MailSendService.deliver` records the
  refusal through `ReputationGate.recordPoolRefusal`.
- `ReputationGate.assertLookalikePool` — `EnrolmentsService` on enrol.
- `ReputationMonitor.afterSync` — at the end of each successful `MailSyncService.syncMailbox` (never throws).
  Findings are written once per mailbox per UTC day (`dedupeKey`), a negative reply once per message.

## Who is told

A CRM refusal is the sender's `422`; the first `bulk_pattern` refusal of a member's day also tells reviewers
(`guardrail:review` holders and admins) with a `guardrail_alert` bell notification. A sync finding tells the
mailbox's owner; `bulk_pattern` (high) tells reviewers too. All appear on the Guardrails page.

## Limits / not done

- Soft limits: two sends judged at the same instant can both pass (no lock across a send).
- Budgets are per workspace, not per role (the spec's "configurable per role" is left for later).
- Pool mailboxes' mail is not judged for repetition (it is a sequence's, meant to repeat); its volume is the pool's
  gate.
