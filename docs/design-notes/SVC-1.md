# SVC-1 — Service inboxes, and what an integration may read of synced mail

Owner (Matt, 2026-10-24). Twenty is shut down; NewswireOS read two things from its synced mail, and now reads them
here: **partner confirmations** (Korewire, ACN, FinanceWire send them to `media@pinionpartners.co` and
`pr@pinionnewswire.com`), and **how much each member sent per day** (its staff email KPIs). The owner connects media@
and pr@, but "their contacts and calendar must not be synced, and the poaching guardrails must not apply to such
accounts". Of the ways to give NewswireOS the confirmations' text, the owner chose: **read service inboxes only**.

## A third mailbox purpose: `service`

`personal` and `pool` stay as they are. A `service` mailbox is a shared address synced so an integration can read it.

|                     | personal                              | pool             | **service**                                                |
| ------------------- | ------------------------------------- | ---------------- | ---------------------------------------------------------- |
| Who connects        | the member (`mailbox:manage`)         | `mailbox:manage` | **an admin** (`workspace:admin`), start and callback       |
| Google scopes       | send, read, calendar                  | send, read       | **read only** (`SERVICE_MAILBOX_SCOPES`)                   |
| Calendar sync       | yes (CAL-1)                           | no               | no — sync only reads `personal`                            |
| Sends               | 1:1 mail                              | sequences        | **never** — `403 a service inbox is read, never sent from` |
| Its mail on records | matched to people, on their timelines | as personal      | **no** (below)                                             |
| Guardrails          | judged (GUARD-2), counts as coverage  | sequences' guard | **not judged**, not coverage                               |

The purpose is fixed when a mailbox connects, as before: pr@, connected today as personal, is disconnected and
connected again as a service inbox.

## Its mail is on no record

One rule, `ON_RECORDS` in `mail-sync/matching.ts`: **a message concerns the CRM's records only when a mailbox that is
not a service inbox holds it.**

- A message a service inbox stores first: its participants are matched to no person (members still are — that is who
  sent it), it is filed on no timeline, and it answers no send (no `email.replied`, so no sequence or deal moves).
- When a member's or a pool mailbox later holds the same message (same RFC 822 Message-ID), its copy matches the
  participants and files it through `reconcileMessageTargets`, exactly as if it had come first (`email.linked`).
- A person created, restored or given an address later (`rematchAddresses`) is not matched to mail only service
  inboxes hold.

Not done: a reply a partner sent only to media@ does not stop a sequence. Sequences go out from pool mailboxes, and a
service inbox is not where prospects answer them.

## What an integration reads

Two capabilities, in no default role. An admin makes a role with them for the NewswireOS API key.

- `mail:service_read` — `GET /integrations/mail/service-messages?since=&until=&from=&cursor=&limit=`: every message a
  service inbox holds, **bodies included**, oldest stored first (`created_at`, monotonic; the Date header is the
  sender's and is never paged on). Mail only a personal mailbox holds is never returned.
- `mail:sent_counts` — `GET /integrations/mail/sent-counts?from=&day=YYYY-MM-DD`: per sender, how many outbound
  messages went that UTC day and the last one's time — counts only, no body or recipient. **Only mail already sent**:
  a Gmail scheduled send is synced when it is scheduled, stamped with the time it will go (production, 2026-10-24:
  messages stored on 10-21 with `sent_at` 10-26), so the count stops at now and a scheduled send counts on its day
  once its time has passed. `complete` says the day has ended.

## Consequence the owner accepted

Partner mail addressed only to a person (84 of 140 Korewire messages went to `max.grey@` alone, 2026-10-24) is not in
a service inbox and so not read. Partners write to, or copy, media@ for their confirmations to be read.

## Tests

`test/cross-tenant/service-inboxes.spec.ts` (SVC-1): admin-only connect with the read scope; no sending; service-only
mail on no record, nor after a person is created; on the record once a member's mailbox holds it; the service-mail
read (bodies, no personal mail, paging, capability, workspace isolation); sent counts (counts only, closed day, a
scheduled send left out, capability).
