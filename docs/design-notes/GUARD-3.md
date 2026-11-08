# GUARD-3 — Cold mail sent around the CRM

Owner ask (2026-11-08): strong guardrails against employees bypassing the CRM and sending cold mail straight from
Gmail. Two layers, because the CRM can only see Gmail (GUARD-2's sync), never stop it: Google Workspace blocks or
quarantines a first-touch external mail that did not come from the CRM, and the CRM records and reports every one
it sees, which is also how the Workspace rule is tuned before it is set to reject.

## In the CRM

One mechanism: GUARD-2's `PoachDetector.judge` (`apps/api/src/guardrails/poach-detector.ts`) already judges every
message that left a member's mailbox. GUARD-3 is a second rule over the same facts:

- **Candidate**: the message has no CRM send linked (`outboundOf` empty — a CRM send carries `X-BylineCRM-Id` and is
  linked by sync), its `In-Reply-To` is empty, and nobody outside the workspace wrote in the thread before it.
- **Findings** (`offCrmColdFindings`, pure, unit-tested): every recipient that is not a member and not on the
  workspace's own domains. The sender's own leads count — the point is the path, not the ownership.
- **Event**: `off_crm_cold`, `warned`, path `sync`, one per (message, address); never twice for one (sender,
  address) in 24 hours (`OFF_CRM_COLD_WINDOW_MS`).
- **Ladder** (`offCrmColdSeverity`): distinct outside addresses by the sender in 24 hours. 1–2 `low` (audit row
  only — a vendor, a partner), `OFF_CRM_COLD_MEDIUM_RECIPIENTS` = 3 `medium` (reviewers told in the bell and the
  digest), `OFF_CRM_COLD_HIGH_RECIPIENTS` = 10 `high` (also emailed at once when `poachEmailAtOnce` is on).
- **Settings → Guardrails → Mail alerts**: `offCrmColdAlerts` (on by default) turns it off; the email-at-once
  switch now covers both GUARD-2 and GUARD-3 highs. Shared mailboxes and members who have left are not senders
  here, as in GUARD-2 (pool and service mailboxes never are).
- **Notification**: `guardrail_off_crm_cold`, listed in the daily digest. Message: who, whom, when, subject and the
  day's count — never the body.

Migration `20261119090000_guard_3_off_crm_cold`: two enum values and one defaulted column; no backfill.

Known gaps: personal (non-Workspace) accounts are invisible; a reply whose Gmail thread does not contain the
inbound (threading broke) may be flagged — a reviewer marks it legitimate.

## In Google Workspace (admin console)

Apply to the sales organisational unit only; managers' OU exempt. Start in quarantine mode for two weeks, read
the quarantine and the CRM's `off_crm_cold` events, then switch to reject.

**1. Apps → Google Workspace → Gmail → Compliance → Content compliance → Add rule**

| Setting            | Value                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name               | `Cold mail must go through the CRM`                                                                                                                       |
| Messages to affect | Outbound only                                                                                                                                             |
| Expressions        | _If ALL of the following match_                                                                                                                           |
| Expression 1       | Advanced content match · Location **Full headers** · Match type **Not matches regex** · `(?im)^(In-Reply-To                                               | References):\s*<` |
| Expression 2       | Advanced content match · Location **Full headers** · Match type **Not matches regex** · `(?im)^X-BylineCRM-Id:\s*\S+`                                     |
| Expression 3       | Advanced content match · Location **Full headers** · Match type **Not matches regex** · `(?im)^(To                                                        | Cc                | Bcc):.*@(pinionnewswire\.com | <every internal domain>)` — _optional; the envelope-recipient filter in step 2 is the reliable version_ |
| If the above match | Phase 1: **Quarantine** → the `Cold mail` quarantine (create under Manage quarantines; notify admins). Phase 2: **Reject message** with the notice below  |
| Rejection notice   | `Cold outreach is sent from Byline CRM, not Gmail. Open the contact in the CRM and send from there. Replies to people who wrote to you are not affected.` |
| Options            | Also affect internal messages: **off**. Bypass for: none                                                                                                  |

**2. Envelope filter on the same rule** (Options → Envelope filter)
Only affect specific envelope recipients → Pattern match → regex: `^.*@(?!(pinionnewswire\.com|<other internal domains>)$)` — so internal mail and mail to the workspace's own domains is never touched.

**3. Security → Access and data control → API controls**
Third-party app access: _Block_ unconfigured apps for the sales OU. Add the CRM's OAuth client ID as _Trusted_. This
keeps Instantly, Lemlist, Apollo, Mailmeteor and the like off work mailboxes.

**4. Apps → Gmail → End User Access** (sales OU)
POP and IMAP access: **off**. Google Workspace Sync: **off**. Allow per-user outbound gateways: **off**.
Apps → Gmail → User settings → Multi-send mode (mail merge): **off**.

**5. Shared mailboxes** (outreach@ and similar) live in the sales OU too, or they are the bypass.

Tuning: a reject hits a legitimate first contact (a vendor, a journalist writing to a new source). Those are what the
two quarantine weeks surface; add the specific recipient domains to the envelope filter's exclusion, or send them from
the CRM as a one-off.
