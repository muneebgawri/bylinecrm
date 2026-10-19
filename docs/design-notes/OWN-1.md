# OWN-1 — Ownership transfers and the manager role (#200)

Issue #200; proposal `PROPOSAL-ownership-and-guardrails.md` §1. Owner ask (2026-10-19): a Manager moves a lead
from one employee to another, employees exchange leads between themselves, and any change of a lead's assigned
Account Manager pings NewswireOS/Pressboard at once. FR-CRMS-17 (transfers), FR-CRMS-18 (manager role).

## What changes hands, and how

Before this, an owner change was a field edit: `PATCH … { ownerId }` by anyone with `record:write`, announced only
as `person.updated` with `diff.ownerId`, with no history, no word to either party and nothing a poaching guard
(GUARD-1) could stand on. Now **a record changes hands only through a transfer**:

| Who                           | How                                                                         | Result                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| The record's owner            | `POST transfers { object, recordId, toMemberId, reason? }` (`record:write`) | `proposed`; the receiver is told (`transfer_proposed`) and accepts or declines            |
| The receiver                  | `POST transfers/:id/accept` / `decline { note? }`                           | `accepted` moves the unit and tells the proposer; `declined` tells them and moves nothing |
| The proposer, or a manager    | `POST transfers/:id/cancel`                                                 | `cancelled`                                                                               |
| A holder of `record:transfer` | `POST transfers` as above                                                   | `forced`: moved at once; old and new owner told (`transfer_taken` / `transfer_received`)  |
| Anyone else editing `ownerId` | `PATCH` or bulk `assign_owner`                                              | `422` with field error `USE_TRANSFER` (`resolveOwner`, `record-scope.ts`)                 |

One open proposal per record (partial unique index `ownership_transfers_open_record_key`). A proposal whose record
changed owner meanwhile is refused on accept (`409`). Transfers are history: the app role has no `DELETE`.

**The unit.** What moves is the record and what goes with it, so a lead and its deal never end up with different
owners (the proposal's §3 makes the company the unit of ownership; this is the first half of that):

- a **company** moves with the people at it and its open deals that the old owner held;
- a **person** moves with their company's unit when the old owner held the company; otherwise alone, with the open
  deals they are the point of contact for;
- a **deal** moves alone.

Records of the unit the old owner did not hold stay where they are. The move runs without the caller's owner scope
(`WorkspaceContext.run` with `ownerScopeMemberId` dropped): a receiver under an own-scoped role cannot see what they
are about to receive, and the transfer is their permission to take it.

## Announced

- `transfer.proposed` / `declined` / `cancelled` / `completed` in the catalogue; `recordId` is the transfer, `transfer`
  the payload: object, record, from, to, by, status, reason, `moved` (the unit) and `identity` — the company's domain
  and the primary emails of the people that moved, because NewswireOS keys its account managers by email and domain,
  not by our ids. The adapter (P5-1a, newswireos#589) subscribes to `transfer.completed`.
- `transfer.completed` carries `targets` = the unit, so the timeline writes `linked-transfer.completed` on each moved
  record ("→ <new owner>"). Each moved record also gets its own `…updated` with `diff.ownerId`, so a subscriber to
  record changes sees the move as any other edit — exactly once per record.

## The manager role

`manager` is the third system role (FR-CRMS-18): a member's defaults plus `record:transfer`, `deal:bulk`,
`view:share`, `sequence:write`, `sequence:enrol`. It exists in every workspace from creation and keeps its name;
an admin edits its capabilities like `member`'s. The migration adds it to every existing workspace that has no
role named `manager`; a workspace whose admin already made a custom role of that name keeps it as it is (a custom
role, not this one) — the operator renames or grants it `record:transfer` by hand.

## Notifications

`notifications` now stands for a task **or** a transfer (`task_id` nullable, `transfer_id` added, exactly one set —
the database checks). Kinds: `transfer_proposed` (receiver), `transfer_accepted` / `transfer_declined` (proposer),
`transfer_received` / `transfer_taken` (both parties of a forced move). The bell shows "Dana Reyes offers you Ortiz
Ltd" with the reason, and opens the record. Nobody is told what they did themselves.

## Routes

`GET transfers?object&recordId&status` — a member sees the transfers they are party to, a holder of
`record:transfer` every one; a record's drawer reads its history by `object` + `recordId`.

## Not here

- **The web UI** is the owner field on every record (`OwnerControl.tsx`): a manager picks a new owner and it moves at
  once; the owner has **Hand on…**; an open offer shows under the field with **Accept / Decline** or **Take back**;
  anyone with `record:write` claims an unowned record. A completed transfer reads "changed the owner → <name>" on
  each moved record's timeline. See OWN-2.md § Web.
- **Company-domain ownership** (first saver owns the company, OWN-2 #201), the recipient guard (GUARD-1 #202) and the
  NewswireOS receiver (newswireos#589) build on this.
- **A transfer cooling period** and **dormancy release** — proposal §4, owner decisions pending.

## Tests

`test/cross-tenant/transfers.spec.ts` (FR-CRMS-17/18 in the titles): a member's `PATCH ownerId` is `422 USE_TRANSFER`;
only the owner proposes; the receiver is told; one open proposal per record; only the receiver decides, once;
accepting moves person + company + open deal and tells the proposer; the history and the timeline entry; a manager's
move is `forced`, both parties told, and a manager may still set `ownerId` directly. `record-scope.spec.ts` covers
the guard in isolation.
