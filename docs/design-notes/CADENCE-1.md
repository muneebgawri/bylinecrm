# CADENCE-1 — Cadence and round-robin lead rotation

Replaces the proposed dormancy flag (decision 6, `OWNER-DECISIONS.md`). Owner decisions (Matt, 2026-10-21): every
open lead has a follow-up cadence set by its stage; one missed cadence warns the owner, and seven more days without a
touch rotate the lead to the next rep in a round-robin. New unowned leads are dealt from the same rotation.

## The lead, and its cadence

- **A lead is an open deal**: not deleted, in an `open` stage, with an owner. Cadence is per stage
  (`pipeline_stages.cadence_days`); closed stages have none. Defaults by stage name: New Opportunity 1, Contacted 3,
  Qualified 3, Proposal Sent 5, Negotiation 3 (and the built-in New 1, Replied 3, Meeting 3); any other open stage 3.
  Editable per pipeline by holders of `pipeline:cadence` (admins and the `manager` role).
- **Never in scope:** customers (the contact's status is `customer`, or the company has a won deal), won deals,
  outreach-excluded contacts (by address or domain), suppressed (Do Not Contact) contacts.
- **A touch** is the latest of: the deal's creation or its last change of hands; an outbound email to the contact or
  a reply from them (CRM or synced Gmail — `people.last_contacted_at` from #249 and inbound mail); a note on the deal or
  the contact (calls are logged as notes); a task on either completed; a meeting with the contact that has started; a
  stage move by the owner.
- **Due** = last touch + the stage's cadence. A planned follow-up (`next_follow_up_date`, #249) defers it to that day,
  at most 14 days past the last touch.
- One SQL function, `refresh_cadence(ids)`, writes `opportunities.cadence_due_at` / `cadence_overdue` and the people's
  `cadence_overdue` (the contact of an overdue deal). The outbox consumer calls it for what an event touches; the
  hourly job for everything. Lists filter on the stored flag ("Overdue" field) and show a badge.

## Warn, then rotate

`cadence_lapses` holds one row per lapse (deal, owner, due). A partial unique index allows one open lapse per deal,
which is what makes the hourly job idempotent: warn once per lapse, rotate once.

1. **Warn.** At `max(due, rotation switch-on) + warn threshold` (default 0 days) the owner is told once
   (`cadence_warning`: bell and the morning digest). `rotate_at` = warned + grace (default 7 days).
2. **Resolve.** A touch, a close, a new owner or an exclusion before `rotate_at` resolves the lapse.
3. **Rotate.** At `rotate_at`, still lapsed: a forced transfer through `TransfersService.rotate`, reason
   `cadence_rotation`, a note saying why (the timeline's "why rotated"). The contact moves when the old owner holds
   them (so the person, the company they held and its open deals move together, OWN-1's unit), else the deal alone.
   The old owner hears `transfer_taken`, the new one `transfer_received`, managers `cadence_rotated`; integrations
   hear `transfer.completed` as for any move (NewswireOS included).

**Switch-on grace:** lapses are measured from `rotation_settings.enabled_at`, so turning rotation on never
mass-rotates an existing backlog. Before switching on, the settings page's dry-run preview evaluates every open lead
and shows what would warn and when it would rotate, with the projected receiver. Nothing is written.

## The rotation

- **Members:** every active seat whose role is not `admin` or `manager` is in by default; a manager or admin can add
  them. Holders of `pipeline:cadence` pause or unpause anyone, with an optional resume date (the job unpauses).
- **Settings** (`rotation_settings`, one row per workspace, all edited on Settings → Rotation): on/off, warn
  threshold, grace (7), intake on/off, mailbox preference (`prefer` a connected or delegated mailbox — default,
  `require` one, or `ignore`), an optional cap on open leads, and per-member weights (1–5, default 1).
- **Picking:** eligible members in a stable order, each repeated by weight; a per-workspace pointer
  (`rotation_settings.cursor`) read under `SELECT … FOR UPDATE`, so concurrent intakes and rotations deal one after
  the other. The previous owner is never the target, nor a member it was transferred away from within the workspace's
  transfer cooling period (Settings → Ownership, #253; 14 days by default). No eligible member: the lapse waits and is retried next hour.
- **Intake:** a new unowned lead — BylineAI inbound (when its own round-robin list is empty), a person or deal saved
  without an owner by an API key or a job (web and inbound routes, imports) at a company nobody owns — goes to the
  next eligible member, when intake is on.

## Risks

- Moving the contact moves OWN-1's whole unit: other open deals at a company the old owner held move with it.
- The overdue flag is refreshed per event and hourly; a touch the outbox has not delivered yet shows as overdue for
  seconds, never longer than an hour.
- A person with no open deal has no stage and no cadence; such leads are not rotated.
