# Proposal — Lead ownership, poaching guardrails, sender-reputation guardrails, invoices, SMTP2Go, BylineAI

**Status:** proposal for owner review, 2026-10-19. Not a work package yet; each section names the work packages
it would become. Grounded in the code as of `f2f5628` and in NewswireOS `apps/api/src/{crm,verification}`.

## What exists already (so we build on it, not beside it)

| Need                              | Already in BylineCRM                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner on every record             | `people.owner_id`, `companies.owner_id`, `opportunities.owner_id`; role `recordScope` `all`/`own`, enforced by a restrictive RLS policy (`records/record-scope.ts`).                                    |
| Changing an owner                 | `PATCH` with `ownerId` (`record:write`) and bulk `assign_owner`. No dedicated transfer, no history, no event: it surfaces only as `person.updated` with `diff.ownerId`.                                 |
| Roles                             | `admin` + `member` + custom roles over the capability catalogue (`packages/shared/src/capabilities.ts`). **No Manager role.**                                                                           |
| Outbound integration              | Signed webhooks (P1-5), BullMQ, retries, catalogue in `packages/shared/src/events.ts`.                                                                                                                  |
| Who may email whom                | `POST /mail/send` applies the sender's record scope (`mail-send.service.ts:977`): an `own`-scoped role can only mail people it owns; an `all`-scoped role can mail anyone.                              |
| Gmail sync                        | Writes thread/message/participant with `personId` + `memberId` per participant, so "member X wrote to person Y" is already recorded. No classification, no alerts.                                      |
| Cold-mail protection of customers | `outreach_exclusions` (address or domain, reason `customer`/`account_managed`, source `newswireos`/`manual`) checked at enrolment and before every sequence step (FR-CRMS-10). Only sequences check it. |
| Reputation controls               | Suppression list, bounce/complaint auto-pause, warm-up ramp, daily caps, jitter, SPF/DKIM/DMARC checks, Postmaster Tools spam rate, region policy, unsubscribe.                                         |
| Open/click tracking               | Built (P3-4): own short-link domain, hashed tokens, bot filtering, `email.opened`/`email.clicked`.                                                                                                      |
| Enrichment / verification         | Free-layer enrichment (P4-2) and email verification with a `Verifier` interface (FR-CRMS-16).                                                                                                           |
| Notifications                     | Bell + digest, but task-only (`notifications.kind` ∈ task_assigned, task_due).                                                                                                                          |
| Attachments                       | Polymorphic `attachments` on person/company/opportunity, local-disk storage only.                                                                                                                       |

NewswireOS side: there is **no inbound CRM webhook today**. It pulls Twenty's `personOwner` hourly
(`crm/twenty-sync.service.ts`) and per minute for new clients, and it only assigns an AM when the client has
none; an owner change for an already-assigned client updates `twenty_workspace_member_owner_id` and never
`account_manager_id`. The human reassign path is `POST api/v1/am/assignments/reassign` →
`am-assignment.service.ts:815` (lock, audit, WordPress push), capability `customer:assign_am`.

---

## 1. Transfers: Manager moves leads, members exchange leads, NewswireOS is pinged at once

**Model.** Make a transfer a first-class thing instead of a field edit.

- New table `ownership_transfers (id, workspace_id, object, record_id, from_member_id, to_member_id,
requested_by, decided_by, status ∈ {proposed, accepted, declined, forced, cancelled}, reason, created_at, decided_at)`.
  History the record drawer shows; the input to the webhook; the audit trail.
- New capability `record:transfer` (move any record between any two members). Admin has it by construction;
  ship a **`manager` system role** = member defaults + `record:transfer` + `deal:bulk` + `guardrail:review`
  (§4) + `workspace:members_read`. Roles stay editable; "Manager" is just the name the owner asked for.
- `PATCH ownerId` is **retired** for non-admin roles (422 `USE_TRANSFER`), so there is one path and one event.
- Member ↔ member exchange: the current owner proposes (`POST /records/:object/:id/transfer {toMemberId, reason}`)
  → the receiver gets a notification (`transfer_proposed`) and accepts or declines. Accept moves the person
  **and** their company and open deals together (§3 says they are one unit). A manager's transfer is `forced`:
  no acceptance, both parties notified.
- Events: `ownership.transferred` (and `ownership.proposed/declined`) added to the catalogue with
  `{object, recordId, from, to, by, reason, companyId, personEmails, companyDomain}` — the receiver needs the
  identity keys, not our ids.

**NewswireOS at once.** Two halves, both needed:

1. **CRM → NewswireOS push:** the P5-1 adapter the corpus already plans. A NewswireOS endpoint
   `POST api/v1/crm/ownership-changed` verifying `x-byline-signature` with the P1-5 receiver example, that
   resolves the customer by `twenty_person_id`/email, maps `to` member → NewswireOS AM by verified email (the
   map `twenty-owner-assignment.service.ts:88-137` already does this), and calls the existing reassign service.
   That closes the "assigned client never changes AM" gap as a side effect.
2. **Why "immediately" is a webhook, not a faster poll:** the hourly reconcile stays as the catch-up for a
   dead endpoint (P1-5 already retries then auto-disables after five dead deliveries, and NewswireOS's rule is
   "nothing fails into silence", so the adapter must log a zero when nothing arrived).

Work packages: **OWN-1** (transfer table, routes, manager role, events, UI), **P5-1a** (NewswireOS receiver, in
the NewswireOS repo). New requirement ids: FR-CRMS-17 (transfer), FR-CRMS-18 (manager role).

## 2. Invoices on a deal, verified before they attach

Pressboard's module verifies a **gateway reference** (Stripe `pi_/ch_/in_`, PayPal capture/`INV2`, Tron/EVM tx
hash) against the gateway: exists, succeeded, amount + currency exact, paid to Pinion, not reused, not
refunded/disputed; a bank receipt file is only stored, never OCR'd. States
`pending → verifying → {verified | invalid | needs_review}`, and uncertainty **never passes**
(`verification.service.ts:294-344`). We should reuse that logic by **calling it, not copying it** (D-239: the
CRM never imports NewswireOS code; the two are on the same box behind the same edge).

- New table `deal_invoices (id, workspace_id, opportunity_id, gateway, reference, amount_minor, currency,
attachment_id?, status, reason_code, verified_at, verification_payload, created_by)`; `UNIQUE(workspace_id, gateway, reference)`
  so one payment is one deal.
- Flow: AM enters reference (+ optional receipt file, stored as a normal attachment) → `verifying` → the CRM
  calls NewswireOS `POST api/v1/verification/lookup` (the existing dry-run verify at
  `pressboard-workspace-data.controller.ts:3843` or the staff lookup at `…payment-verification.controller.ts:570`,
  exposed to a CRM API token) with `{gateway, reference, expectedAmountMinor, currency}` → result stored.
  Only `verified` attaches as an invoice; `invalid` is refused with the reason; `needs_review` sits in the
  deal with a "waiting for finance" badge and a `invoice.needs_review` notification to the manager role.
- Amount expectation: the deal's `amount_minor`/`currency` by default, overridable per invoice (partial payments).
- Later: a stage rule "move to Won when a verified invoice ≥ deal amount is attached" (StageRule event
  `invoice.verified`), and refund/chargeback flips back (`invoice.invalidated`) via the same webhook channel as §1.
- A workspace with no NewswireOS link gets `needs_review` → manual verify by a role with `invoice:verify`
  (mirrors FR-VER-9).

Work package: **INV-1**. FR-CRMS-19.

## 3. Deals and ownership are per company; first saver owns the company

**Rule.** The owner of a company owns every person at that company and every deal with it. "First to save a
contact at a company" = creating the company record (or the first person whose domain matches it).

- **Domain is the key.** On person create/patch, derive the domain of the primary email; if it is not a free
  mailbox domain (reuse the disposable/free list the verifier has) and a non-deleted company in the workspace
  has that `domain` (or an alias in a new `company_domains` table for multi-domain groups), link
  `companyId` automatically and **set `ownerId` to the company's owner**, whoever is saving.
- If the saver is not that owner: `409 COMPANY_OWNED {companyId, ownerName, since, counts}` with two actions
  the UI offers: **Hand this lead to <owner>** (creates the person owned by them + notification), or **Request
  a transfer** (§1 proposal, the owner decides). No third path. Admin/manager may override with a reason.
- Company create with a `domain` that collides → same 409.
- Deals: `opportunities.companyId` becomes required for new deals (a person-only deal gets its company created
  from the person's domain), and a deal's owner is derived from the company's owner; a transfer (§1) moves the
  whole unit.
- Companies with no domain (free-mail contacts, sole traders) stay person-owned; the rule is explicit in the
  UI copy so nobody thinks it failed.
- Mail sync and calendar sync create no people today; when they do (CAL-1 leads), the same service runs, so a
  meeting with someone at an owned company becomes the owner's lead, with the meeting host told.

Backfill: a one-off report of people whose domain matches a company owned by someone else, for the manager
to resolve before the rule is turned on (it cannot be applied silently to 1,000+ imported records).

Work package: **OWN-2**. FR-CRMS-20.

## 4. Poaching guardrails (owned leads) and 5. cold-mailing customers / in-negotiation prospects

These are one mechanism: a **recipient guard** that every outbound path consults, and a **sync detector** for
mail that bypassed the CRM.

**4a. In the CRM (prevent).** A single `RecipientGuard.check(senderMemberId, address) → allow | block(reason)`
used by 1:1 send, reply, scheduled send at its time, sequence enrolment, every sequence step and bulk actions.
Reasons, in order:

1. `suppressed` (exists). 2. `excluded_customer` / `excluded_account_managed` (exists, but today only sequences
   check it — extend to 1:1 send). 3. **`owned_by_other`**: the address resolves to a person, or to a company
   domain, owned by another member, and the sender lacks `record:transfer`. 4. **`in_negotiation`**: the
   address's company has an open deal owned by someone else (a stronger message than 3; same block). 5. `cold_to_known`: a _sequence_ enrolment of a person who already has a two-way thread with anyone in the
   workspace (cold-mailing a warm contact) — warn, and block unless the owner enrols.
   Admins are not exempt from 2; they are exempt from 3–4 and the attempt is still logged.

Every block writes `guardrail_events (workspace_id, kind, severity, actor_member_id, person_id?, company_id?,
address, detail, notified_member_ids, created_at)` — the audit the manager reads. Three blocks on owned
addresses in a day → a `guardrail.repeat_blocks` notification to managers.

**4b. From Gmail (detect).** Mail sync already stores every participant with `memberId` and `personId`. Add a
subscriber on `email.sent`/`email.received`: for each outbound message where `from` is member X and a `to/cc`
participant resolves to a person or company domain owned by member Y ≠ X, and the message is **not** a reply in
a thread Y is on (cc'd colleague replies are legitimate), write a `guardrail_events` row of kind
`poach_suspected` and notify **Y and every manager/admin** (new notification kinds; the bell plus the daily
digest, with an immediate email for `high` severity). Also notify when X mails an `outreach_exclusions`
customer. The message's body is never in the notification, only who, whom, when, subject.

Severity ladder: first contact = `medium`; 3+ distinct owned leads in 7 days = `high`; a sequence-like pattern
(§6) = `high`. Managers see a **Guardrails** page: events, filters, "mark legitimate" (with reason, stored).

**Further ways to make poaching not pay** (policy suggestions, each cheap once the above exists):

- **Attribution follows ownership, not sending.** KPIs, leaderboard and "deals won" count for the record
  owner at the time of the event; a poached win is credited to the owner. Removes the incentive.
- **Transfer cooling period.** A transferred company cannot be transferred again for 14 days except by a manager.
- **Owner-only Gmail reply.** The record drawer hides "Compose" for non-owners and shows "Ask <owner> to
  introduce you" (a note + notification) instead.
- **Dormancy release.** If an owner has had no outbound mail, meeting or note on a company for N days
  (workspace setting, e.g. 60), the company shows "unworked" and a manager can reassign in bulk — this is the
  pressure valve that makes a hard ownership rule acceptable to the team.
- **Exports are scoped.** CSV export of people/companies limited to the member's own records unless
  `record:export_all`; export is audited.
- **BCC trap for direct Gmail.** Not needed: the sync already sees the sent mail. The real gap is a member
  mailing from a **non-connected** address, which only policy covers: require every AM's work mailbox to be
  connected (admin sees "members with no connected mailbox").

Work packages: **GUARD-1** (recipient guard + events + manager page), **GUARD-2** (sync detector + notifications).
FR-CRMS-21, -22.

## 6. Spam / sender-reputation guardrails, in the CRM and in Gmail

What already protects the domain: pool caps, warm-up, bounce/complaint pause, suppression, DNS checks,
Postmaster spam rate, region policy, unsubscribe. The gaps are **personal mailboxes** (none of the pool controls
apply to a member's own Gmail) and **content-level repetition**. Recommendations, in priority order:

1. **Per-mailbox daily send budget, personal mailboxes included.** Default 50 new-recipient messages/day for
   a personal mailbox (replies in existing threads do not count), configurable per role. Enforced at send
   (CRM) and _measured_ from sync (Gmail): a mailbox over budget from direct Gmail use gets a `volume_anomaly`
   guardrail event. Google's own limit is 2,000/day for Workspace, but reputation damage starts far lower
   for cold mail; 50–100 is the industry norm per inbox.
2. **Near-duplicate detection (the templating problem).** Normalise the body (strip signature, quoted text,
   greeting line, URLs, numbers, whitespace), compute a **simhash** and store it per outbound message
   (`mail_messages.body_simhash`, also computed for synced sent mail). A mailbox sending ≥ N (default 10)
   messages within 24h whose simhash Hamming distance ≤ 3, to distinct recipients, outside a sequence =
   `bulk_pattern` guardrail event, `high`, sender warned in-app, managers + admins notified. In the CRM the
   same check runs _before_ send: the 11th near-identical 1:1 message of the day is refused with "use a
   sequence from the pool" — because the pool has the controls and the personal domain does not.
3. **Subject-line repetition** is the cheap first signal: same normalised subject to ≥ 10 distinct new
   recipients in 24h → same event. Keep it separate from 2 so each is tunable.
4. **Primary-domain protection rule.** Sequences may only run from pool mailboxes on lookalike domains
   (already the design, D-248); make it a hard check, and refuse enrolment from a mailbox whose domain is
   the workspace's primary domain. Personal mailboxes are for 1:1 and replies only.
5. **Content lint at compose time** (warn, not block): spam-trigger words, all-caps subject, link-only body,
   no plain-text alternative, missing unsubscribe on anything sent to a `source != manual` contact, image-heavy
   body, more than 3 links. Cheap, client-side, educates rather than polices.
6. **Recipient quality gate.** Refuse a send to an address whose verification is `invalid`, warn on `risky`,
   verify `unknown` just-in-time (the verifier exists). Bounces are the fastest way to lose a domain.
7. **Reply-rate floor.** A mailbox whose 7-day reply rate on new-recipient mail is < 1% with ≥ 50 sends is
   paused for new recipients until a manager lifts it; low engagement is what Gmail's filters learn from.
8. **Spam-rate kill switch.** The Postmaster reading already exists: at ≥ 0.3% spam rate (Google's
   threshold), pause _all_ cold sends from that domain automatically and alert admins; at 0.1% warn.
9. **One-click unsubscribe headers (RFC 8058) on every non-reply message**, personal mailboxes included;
   Google and Yahoo require it for bulk senders and treat its presence as a positive signal.
10. **Gmail-side anomaly feed.** Everything above that is measured from sync (volume, simhash, subject,
    bounce replies, "unsubscribe"/"remove me" replies as negative signals) lands in `guardrail_events` and
    the Guardrails page, with the sender warned by the bell and managers/admins notified at `high`.

What I would not do: content "AI spam scoring" on every message (cost, false positives, and it does not
change behaviour); blocking replies ever (replies are the safest mail a domain sends).

Work packages: **REP-1** (budgets + repetition detection + events), **REP-2** (compose lint, quality gate,
kill switches). FR-CRMS-23, -24.

## 7. SMTP2Go for open/click/reply tracking

Tracking is **already built** on our own short-link domain (P3-4) with bot filtering. SMTP2Go's tracking only
works for mail SMTP2Go relays, so using it means **sending through SMTP2Go instead of Gmail**, which changes
the deliverability story: the mail no longer carries Google's sending reputation and the sent copy is not in
the member's Gmail unless we also insert it via the Gmail API.

Recommendation: do **not** move 1:1 or personal mail to SMTP2Go. Use SMTP2Go, if at all, as a **second
transport for the outreach pool** behind the existing `MailTransport` seam: pool mailboxes may be `gmail` or
`smtp2go` (the latter with its own DKIM-signed lookalike domains), SMTP2Go's webhook feeds `email.bounced`,
`email.complained`, `email.opened`, `email.clicked` into the same tables the Gmail path writes, and reply
detection stays ours (a reply arrives in whichever mailbox is the `Reply-To`; the sync already matches by
In-Reply-To). Benefit: dedicated IPs, suppression sync and bounce webhooks without the Gmail per-user caps.
Cost: a second warm-up, a second place the suppression list must be mirrored. Work package **TRANS-1**, after
Phase 3 proves volume needs it; the subscription alone is not a reason.

## 8. BylineAI: connect, do not fold in

BylineAI is more built than its README says: ~18k lines, 21 controllers, discovery/extraction/enrichment
pipeline, its own review UI and auth, last commit 2026-09-14. Folding it in means Prisma 7 → 6, Zod 4 vs 3,
BullMQ 6 vs 5, a Next.js UI rewritten for Vite, a string `tenantId` remodelled onto RLS, and Playwright
crawling plus Reacher SMTP probing inside the CRM's process and IP reputation. Connecting costs one receiver.

- BylineAI already has a **WEBHOOK export connector** (HMAC `x-byline-signature`, payload keyed on
  `lead_id = Contact.id`, success read from the body as `ingested | duplicate | rejected`). Add
  `POST /api/w/:id/inbound/byline` to the CRM: verify HMAC, upsert person + company by email/domain (§3 rules
  decide the owner — the company's owner if one exists, else round-robin among a configurable list of members,
  else unassigned to a "Leads" queue), `source = byline:<source_key>`, answer `{status}` in BylineAI's shape.
  Point `BYLINE_WEBHOOK_URL` at it. Lead Engine on Twenty currently receives these; cut over when the Twenty
  importer cutover happens (doc 48 §11).
- Enrichment: expose BylineAI's enrichment as an **`EnrichmentSource` adapter** in the CRM (P4-2's interface):
  the CRM asks `GET /enrichment/:email` on BylineAI with an API key, and BylineAI's paid layers (Apollo/PDL,
  Reacher, LLM) run under BylineAI's budget caps. Same for email verification: BylineAI as a `Verifier`
  adapter (FR-CRMS-16 "vendor behind an interface"), with Reacher kept on its own clean box.
- Share `@byline/contract` (StandardizedContact + HMAC) as a package both repos depend on, so the payload
  has one definition.
- Revisit folding only if review must move into the CRM; today review is a BylineAI step by design (ADR-0009).

Work packages: **BYL-1** (inbound receiver + owner assignment), **BYL-2** (enrichment/verifier adapters).

## Suggested order

1. OWN-1 + OWN-2 (ownership model and transfer) — everything else keys off "who owns this address".
2. GUARD-1 + GUARD-2 — the poaching prevention and detection the owner asked for first.
3. REP-1 — budgets and repetition detection (the Gmail-side detector shares GUARD-2's subscriber).
4. P5-1a — NewswireOS receiver (NewswireOS repo), then INV-1 on the same API-token channel.
5. BYL-1, REP-2, BYL-2, TRANS-1.

Open owner decisions: the free-mail domain rule in §3 (person-owned, or block?); transfer cooling days;
per-mailbox daily budget default; whether managers are exempt from `owned_by_other` or only admins; whether
SMTP2Go is worth a second warm-up before Phase 3 volume is known.
