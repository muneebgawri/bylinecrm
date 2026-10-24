# Owner decisions — ownership and guardrails

The "Open owner decisions" in [PROPOSAL-ownership-and-guardrails.md](PROPOSAL-ownership-and-guardrails.md)
(last section), each with what the code did when it was written and the recommendation. Decisions 1, 3, 4 and 5
keep the current behaviour. Decision 2 is built: see its section. Decision 6 is superseded.

## 1. Free-mail domains (§3): person-owned, or block?

- **Question.** A person at a free-mail address (gmail.com, outlook.com…) has no company to inherit an owner
  from. Do they stay owned by whoever created them, or is creating them blocked?
- **Current behaviour.** Person-owned. `companyDomainOf` returns `null` for free mail
  (`apps/api/src/records/company-ownership.ts:19-25`, via `isFreeMailDomain` in
  `apps/api/src/enrichment/email-domain.ts`), so no `409 conflict.company_owned` is raised and the creator owns
  the person. The same rule is applied elsewhere: free mail never matches a company in poaching detection
  (`apps/api/src/guardrails/poach-detector.ts:283,345`), outreach exclusions fall back to the address
  (`apps/api/src/customers/exclusion-target.ts:21`), and invoices never send a free-mail domain to NewswireOS
  (`apps/api/src/invoices/invoices.service.ts:534`).
- **Recommendation.** Keep person-owned. Blocking would stop sole traders and freelancers, who are real
  customers, and the person-level `owned_by_other` guard still protects them once someone owns them.
- **Status: DECIDED (2026-10-21, Matt)** — approved as recommended.

## 2. Transfer cooling days

- **Question.** After a transfer, how long before the same company can be transferred again (except by a
  manager)? The proposal suggests 14 days (§4).
- **Current behaviour.** No cooling period. `TransfersService` allows one open proposal per record and a
  forced move by any `record:transfer` holder at any time (`apps/api/src/transfers/transfers.service.ts:41-48`).
  OWN-1 left cooling and dormancy release out pending this decision (`docs/design-notes/OWN-1.md:74`).
- **Recommendation.** 14 days for member-to-member proposals, with managers exempt. That stops ping-pong
  without slowing down a manager who is fixing an assignment.
- **Built (2026-10-21).** For the cooling period after a record is transferred away from a member, it cannot be
  offered to them or accepted by them again. The refusal is a `409 conflict.transfer_cooling` that gives the date
  it unlocks (`details.unlocksAt`). A transfer counts whether the record was its subject or moved with the
  company. Holders of `record:transfer` (managers and admins) are exempt, and so are their forced transfers. The
  period is a workspace setting, 14 days by default and 0–90 allowed (0 turns it off). Managers and admins set it
  in Settings → Ownership (`GET/PUT /ownership/settings`). Code is in `apps/api/src/transfers/transfer-cooling.ts`.
- **Status: DECIDED (2026-10-21, Matt)** — approved as recommended.

## 3. Per-mailbox daily send budget default

- **Question.** How many new-recipient messages a day may a personal mailbox send? The proposal suggests 50
  (§6.1).
- **Current behaviour.** 50 new recipients/day and 20/hour per mailbox, as workspace-wide reputation settings
  (`apps/api/prisma/schema.prisma:1857-1858`, enforced in `apps/api/src/reputation/reputation-gate.ts:106`).
  Pool mailboxes have their own cap of 40/day (`packages/shared/src/sending-pool.ts:23`). The budget is set per
  workspace, not per role as the proposal described.
- **Recommendation.** Keep 50/day and 20/hour. That is the low end of the 50–100 industry norm for cold mail,
  and admins can raise it. Leave per-role budgets until a team actually asks for them.
- **Status: DECIDED (2026-10-21, Matt)** — approved as recommended.

## 4. Manager exemption from `owned_by_other`

- **Question.** Are managers exempt from the recipient guard's ownership checks, or only admins?
- **Current behaviour.** Anyone holding `record:transfer` is exempt from checks 3–5 (`in_negotiation`,
  `owned_by_other`, `cold_to_known`). The attempt is still recorded as `allowed`
  (`apps/api/src/guardrails/recipient-guard.ts:124,148,224`). The `manager` system role has `record:transfer`
  by default (`packages/shared/src/capabilities.ts:66-90`), so managers are exempt today. Suppression and
  customer exclusions still apply to everyone (`recipient-guard.ts:112-117`).
- **Recommendation.** Keep managers exempt. A manager can already force a transfer, so blocking their mail
  protects nothing, and every exempt send is still logged as `allowed` for review.
- **Status: DECIDED (2026-10-21, Matt)** — approved as recommended.

## 5. SMTP2Go: worth a second warm-up before Phase 3 volume is known?

- **Question.** Should the SMTP2Go transport (TRANS-1) be put into use now, at the cost of warming up a second
  set of domains and mirroring suppression, or wait until real sequence volume is known?
- **Current behaviour.** Built but opt-in. An admin must add an SMTP2Go mailbox before anything goes through
  it (`apps/api/src/smtp2go/smtp2go-mailboxes.service.ts:17-23`). The database allows SMTP2Go only for pool
  mail (`docs/design-notes/TRANS-1.md:15`). An SMTP2Go mailbox starts the same warm-up as a Gmail pool mailbox
  (5/day rising to the cap over 21 days; `apps/api/src/sending-pool/pool-mailbox.ts:13-20`,
  `packages/shared/src/sending-pool.ts:22-25`). No SMTP2Go mailbox is connected unless an admin adds one.
- **Recommendation.** Don't warm up SMTP2Go yet. Use it only if pool volume nears the Gmail pool's combined
  cap or Postmaster spam rates rise. Until then a second warm-up costs effort and buys nothing.
- **Status: DECIDED (2026-10-21, Matt)** — approved as recommended.

## 6. Dormancy release (§4, related)

- **Question.** After how many days without outbound mail, a meeting or a note does an owned company show as
  "unworked" so a manager can reassign it in bulk? The proposal suggests 60 days.
- **Current behaviour.** Not built (`docs/design-notes/OWN-1.md:74`). Managers can still reassign one record at
  a time with a forced transfer.
- **Recommendation.** 60 days, as a workspace setting, flag only (nothing moves automatically). This is what
  makes the strict ownership rule workable for the team.
- **Status: SUPERSEDED (2026-10-21, Matt)** — to be replaced by cadence plus round-robin lead rotation (design pending). The dormancy flag is not to be built.

## 7. Service inboxes and NewswireOS's mail reads (SVC-1)

- **Question.** Twenty is shut down. NewswireOS read partner confirmations and staff email counts from Twenty's synced
  mail. media@ and pr@ are to be connected without their contacts or calendar synced and outside the poaching
  guardrails. How does NewswireOS get the confirmations' text, which BylineCRM shows only to a mailbox's owner?
- **Options.** (A) the integration key reads bodies of mail from listed partner senders, in any inbox; (B) it reads
  everything service inboxes hold and nothing in personal inboxes; (C) BylineCRM parses the confirmations itself.
- **Recommendation.** A — it keeps the coverage Twenty gave (84 of 140 Korewire messages went to one person's inbox
  only) with the narrowest exposure, and partner parsing stays in NewswireOS.
- **Status: DECIDED (2026-10-24, Matt)** — B. A new `service` mailbox purpose (mail only, admin-connected, read
  scope, no calendar, no sending, on no record, outside the guardrails); partners write to or copy media@. Scheduled
  sends are left out of the sent counts. See `SVC-1.md`.
