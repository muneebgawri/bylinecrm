# GUARD-1 — One recipient guard for every send path (#202)

Issue #202; proposal `PROPOSAL-ownership-and-guardrails.md` §4a/§5. Owner ask (2026-10-19): an account manager must
not mail another account manager's leads (anti-poaching), nobody cold-mails an existing customer or a prospect
someone else is negotiating with, and the owner and managers hear of it. FR-CRMS-21. Builds on OWN-1 (transfers,
the manager role) and OWN-2 (company-domain ownership).

## The guard

`RecipientGuard.check({ path, recipients, outreach, replyToMessageId?, record? })` (`apps/api/src/guardrails`) is
asked by every path mail leaves through. The sender is the caller in the current workspace scope:

| Path             | Where it asks                                                                 | Sender                                       |
| ---------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| `send`, `reply`  | `POST /mail/send` (`MailSendService.preparePersonal` → `SendPolicy`)          | the member                                   |
| `scheduled_send` | the send's job at its time (a retry is one: it reschedules and builds again)  | the member who scheduled it, as they are now |
| `sequence_enrol` | `EnrolmentScreen` — the preview (nothing recorded) and the enrol, one or many | the enrolling member                         |
| `sequence_step`  | each step's send at its time (`prepareOutreach` → `SendPolicy`)               | the member who enrolled the person           |

A delivery attempt of a message already built asks only the suppression list, as before. There is no other send
path: an API key cannot send personal mail or enrol (both need a member), and bulk enrolment is the enrol route.

**Reasons, in order** — the first that holds is the verdict:

1. `suppressed` — everyone; still refused as `422 recipient.suppressed`.
2. `excluded_customer` / `excluded_account_managed` — the outreach exclusions (FR-CRMS-10), now for one-to-one mail
   too. Admins are not exempt. For one-to-one mail the record's owner (the person's, or the company's at the
   address's domain) may still write to their own customer, and anyone may answer a thread the customer wrote in;
   a sequence never reaches one.
3. `in_negotiation` — the address's company (the person's, else by domain) has an open deal another member owns.
   Told instead of 4: it is the stronger message.
4. `owned_by_other` — the person, or the company at the address's domain (OWN-2's rule), is another member's.
   A reply in a thread that member is on (a colleague cc'd them in) is allowed.
5. `cold_to_known` — enrolment only: the address wrote in a thread the workspace also wrote in. The person's owner
   (or a holder of `record:transfer`) enrols with a warning; anyone else is refused.

3–5 bind members without `record:transfer`. A manager or admin is let through and the attempt is kept as `allowed`.
Ownership is read across the workspace, outside an own-scoped caller's record scope, so an account manager who
cannot see a colleague's lead is still told whose it is — and nothing more of it.

**Refusal.** `422 recipient.guarded`, each recipient named at its field (`to`, `cc`, `bcc`); `details.reason` is the
first one's kind and, for another member's lead, `ownerMemberId` / `ownerName`. A scheduled send or step refused at
its time fails with that code (the step's enrolment is held with the message). An enrolment refusal uses the codes
`owned_by_other`, `in_negotiation`, `cold_to_known` beside the existing ones; `cold_to_known` is also a warning.

## guardrail_events

Every verdict other than a pass is a row: `kind`, `outcome` (`blocked` / `warned` / `allowed`), `severity`, `path`,
`actor_member_id`, `owner_member_id` (whose lead), `person_id`, `company_id`, `address`, `message` (what the sender
read), `detail` (JSON facts), `notified_member_ids`, and a review (`legitimate_at/by/reason`). RLS by workspace like
its neighbours; the app role cannot delete. Enums are Postgres enums, so GUARD-2 (`poach_suspected`, path
`gmail_sync`) and REP-1/2 (`volume_anomaly`, `bulk_pattern`) add values rather than tables. `dedupe_key` (unique per
workspace) makes a once-a-day event idempotent.

**Repeated blocks.** A member's third block on owned addresses (`owned_by_other`, `in_negotiation`) in a UTC day
writes one `repeat_blocks` event (high) and a `guardrail_repeat_blocks` notification to every reviewer — members whose
role has `guardrail:review`, and admins — never to the member. The bell says who and how many, never what they wrote.
Notifications now point at a task, a transfer **or** a guardrail event (exactly one; the database checks).

## Capabilities

- `guardrail:review` — read `GET /guardrails/events` (filters: `kind`, `outcome`, `actorMemberId`, `reviewed`;
  newest first, cursor-paged) and `POST /guardrails/events/:id/legitimate { reason }` (once; `409` after). Told of
  repeated blocks. In the `manager` defaults; the migration grants it to every system manager role.
- `record:export_all` — CSV exports of people, companies and deals hold only the member's own records without it
  (API keys are unaffected). Also a manager default.

## Web

- **Settings → Guardrails** (`guardrail:review`): the events with filters by reason and review state, and
  **Mark legitimate** with a reason.
- **Another member's lead**: the person record shows "Ask <owner> to introduce you" where the composer would be; the
  `e` key and the Email action open it. Asking makes a task on the person assigned to the owner, so they hear of it
  in the bell and My tasks. Managers still see the composer.
- **The bell** shows `guardrail_repeat_blocks` and opens the Guardrails page.

## GUARD-1b: exports audited, guardrail events announced

The owner (2026-10-20): audit exports, and send guardrail events to webhooks.

- **Export audit.** Every CSV export of people, companies or deals (`GET`/`POST …/export.csv`) writes a
  `guardrail_events` row before the first row of the file: kind `record_export`, path `export`, outcome `allowed`,
  severity `low`, the actor, and in `detail` the `object`, `scope` (`own` without `record:export_all`, else `all`),
  `rows`, and the `filter` / `q` / `view` asked for (an API key's id when a key exported). There was no workspace
  audit table to reuse (`platform_audit` is the operator's, outside any workspace), and the Guardrails page is
  where reviewers already look: exports show there under **Export**. A refused export (`413`) is not recorded.
- **`guardrail.recorded`.** One domain event per guardrail event, recorded in the same transaction by the one
  writer (`guardrails/record.ts`), so the outbox, webhooks and the Guardrails page never disagree. `recordId` is
  the event; `guardrail` carries kind, outcome, severity, path, actor, owner, person, company, address, the
  guard's message and `detail` — ids and addresses, never a message body (the guard never sees one) or an
  export's rows. A `repeat_blocks` row written once a day announces once. It is not on any record's timeline.

## Not here

- Detecting mail sent outside the CRM, and telling the lead's owner — GUARD-2 (#203).
- Volume, near-duplicate and reputation guardrails — REP-1/REP-2 (#204, #205).

## Tests

`test/cross-tenant/guardrails.spec.ts` (FR-CRMS-21): own lead sent; another member's lead refused by name with
nothing queued and the attempt kept; a cc at a company in negotiation refused; a customer refused to a non-owner;
the third block tells the manager and the admin once, not the member; a manager let through as `allowed`; a
scheduled send whose lead changed hands meanwhile fails at its time; reviewers only, marked legitimate once; another
workspace sees nothing; exports scoped. `sequences.spec.ts` covers enrolment (another member's lead refused, a warm
contact refused to a non-owner and a warning to its owner, all recorded).

GUARD-1b: `guardrails.spec.ts` — an export is audited with its scope and row count (own for a member, all for a
manager); a block is announced as `guardrail.recorded` with ids only and reaches a subscribed webhook.
