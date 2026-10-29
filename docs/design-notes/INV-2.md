# INV-2 — Paid invoices from NewswireOS move deals

**Problem.** A deal moves to Won only when an Account Manager types the invoice onto it (INV-1). NewswireOS already
tells the CRM when an invoice is paid (`invoice.paid`, PNW-766), but only for the timeline.

**Decision.** A paid invoice NewswireOS reports goes on the client's deal **as if an Account Manager had entered it**:
`InvoicesService.attachIn` → the same NewswireOS verification (INV-1, §8q) → the same `invoice.verified` stage rule.
There is no second way of moving deals: partial payments (`covers`), refunds and chargebacks (`invoice.invalidated`),
ownership (OWN-2) and the Won announcement (`deal.won`) all work as they already do.

- **Paid, not generated.** An unpaid invoice is not revenue; only `invoice.paid` acts. `order.paid` carries no invoice
  number (an order paid through an invoice arrives as `invoice.paid`), so it stays timeline-only.
- **Which deal — never guessed** (`planFor`):
    1. Already entered by an Account Manager (same `newswireos_invoice` reference, not refused) → `already_on_deal`;
       nothing is done.
    2. `byline_opportunity_id` names a live deal (the invoice was raised from it) → `attached`, `matchedBy: deal_id`.
    3. The client (matched as the timeline matches: contact id, company id, email, domain) has exactly one open deal →
       `attached`, `matchedBy: only_open_deal`.
    4. No open deal → `created_deal`: a deal ("<client> — NewswireOS payment") is made for the payment (the record's company and contact, the record's
       owner, the amount paid, lead source NewswireOS) and the invoice put on it; the stage rule then closes it Won, as
       any deal. The owner is told (`payment_created_deal`).
    5. Several open deals → `needs_deal`: nothing is attached; the owner is asked (`payment_needs_deal`) and chooses on
       `/w/:ws/payments/:id` (`POST /newswireos-payments/:id/choose`: the deal's owner, or whoever verifies invoices).
    6. No one in the CRM is the client → `unmatched`: whoever verifies invoices is told (`payment_unmatched`) and may
       choose any deal.
       A deal that refuses the invoice (no amount to expect, the payment already elsewhere) falls back to `needs_deal`
       rather than failing the hook, which NewswireOS would retry for ever.
- **Rollout.** `newswireos_settings.payment_mode`: `off` | `shadow` (default) | `on`. Shadow records the decision in
  `newswireos_payments` and acts on nothing; Settings → NewswireOS lists recent payments beside the deal an Account
  Manager entered the same invoice on (`agrees`). Switch to `on` per workspace once they agree.
- **Once.** One `newswireos_payments` row per (workspace, invoice number): a redelivery, or the same invoice reported
  again, does nothing twice. The hook asks on a redelivery too, so a payment a failed delivery left undone is done
  on NewswireOS's retry.

## The contract with NewswireOS

`invoice.paid`'s `data` gains three fields (additive; everything else as PNW-766):

| Field                   | Type           | Meaning                                                                                                                              |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `invoice_number`        | string         | The invoice's number (`INV-202610-000067`): the `newswireos_invoice` reference the lookup verifies. Without it, nothing is attached. |
| `payment_method`        | string \| null | `stripe` \| `paypal` \| `wallet` \| `crypto`. Shown; the lookup resolves the rail.                                                   |
| `byline_opportunity_id` | string \| null | The CRM deal the invoice was raised for (set from the CRM's "Raise invoice" link); otherwise null.                                   |

NewswireOS stores `byline_opportunity_id` on the invoice (nullable) and accepts it on
`POST /api/workspaces/:slug/clients/:clientId/invoices/generate`. Pressboard (a UI over NewswireOS, with no invoices
of its own) passes it from the CRM's deep link into its generate-invoice modal.

## Raising an invoice from a deal

A deal's Invoices card links to **Raise invoice in NewswireOS** (`GET /opportunities/:id/invoices/newswireos-link`):
`{dashboardUrl}/clients/{customerId}/?generate_invoice=1&byline_opportunity_id={dealId}`, where `dashboardUrl` is set
once in Settings → NewswireOS (the dashboard's workspace address) and `customerId` is the NewswireOS client id the CRM
knows for the deal's contact or company (kept by the won-deal push, else the latest timeline event about them).
Pressboard opens Generate invoice for that client and sends the deal id, so the paid invoice comes back naming it.

## Safety rules (review, 2026-10-29)

- **A named deal must be the client's.** `byline_opportunity_id` is only trusted when the deal's contact or company is
  the paying client; otherwise (another client's deal, an unknown payer) the deal's owner confirms it
  (`needs_deal`). An id typed into the link cannot credit a payment to an unrelated deal.
- **Choosing is bounded.** An owner chooses among the deals offered; only whoever verifies invoices may put a payment on
  any deal or place a stranger's. A payment is visible only to reviewers, those notified of it, and the owners of its
  deal or candidates (404 to anyone else).
- **One decision per invoice at a time.** A transaction advisory lock on (workspace, invoice number) serialises a
  redelivery racing the first, and two people choosing at once.
- **Refusals never loop.** If placing the payment fails (the invoice entered elsewhere at that instant, no amount), the
  transaction rolls back and the payment is decided again as `needs_deal`, so the hook answers 2xx.
- **Nothing for nothing.** A payment of 0 moves no deal; with no amount reported no deal is created.
- **Departed owners** are not notified; the reviewers are, as they are when there is no deal to offer.

Known limit: a payment recorded in shadow is not acted on when the mode is later switched on.

## Replays and lost verifications (2026-10-29)

- **Replay protection.** NewswireOS signs every delivery with `x-webhook-timestamp` (Unix seconds) and
  `x-webhook-signature-v2: sha256=HMAC(secret, "${timestamp}.${body}")`, fresh per attempt. The CRM's hook requires
  both and refuses a delivery signed more than 5 minutes from now (`stale`), so one captured on the wire cannot be
  posted again later; the body-only `x-webhook-signature` is no longer accepted alone. **NewswireOS #916 must be
  deployed before this CRM release**, or the CRM refuses its deliveries (NewswireOS retries them, so none is lost).
- **Lost verifications.** A sweep in the invoice worker re-queues every invoice still `verifying` 10 minutes after it
  was last touched (500 a run, every 10 minutes, by a partial index on `verifying` rows). Jobs are keyed on the
  invoice, so a live one is never doubled.

## Lead pool and domain-only matches (2026-10-29)

- **Lead pool.** A client another workspace of this one's lead pool holds (a customer or prospect there,
  `lead_pool_holders`) is that workspace's payment: unless the client was matched here by this CRM's own ids (which
  name nothing elsewhere), the payment is recorded `pooled_elsewhere` and nothing is done or told. Were two pooled
  workspaces both linked to NewswireOS, the payment would otherwise count twice. (Production 2026-10-29: only
  Pinion Newswire is linked; Lexiswire is not.)
- **Domain-only matches never create a deal.** A client matched by company domain alone (an agency paying for a
  client, a shared domain, someone who moved) still goes on the company's only open deal; with none, it is
  `needs_deal` and the company's owner is asked. "Create a deal for this payment" (`POST /newswireos-payments/:id/
create-deal`; the client's owner or a reviewer) makes it in one click, as the automatic path would.

## Knowing each client's NewswireOS id (INV-2b)

"Raise invoice in NewswireOS" needs the deal's contact or company to carry its NewswireOS client id
(`newswireos_customer_id`); at launch only the won-deal push set it, so almost no deal had the link. One writer,
`keepNewswireosClient`, now takes it from every source: the won-deal push replaces a person's (NewswireOS's own
answer); every NewswireOS timeline event fills the record it matched; the client CSV (`sync-newswireos-clients`,
optional third field `email,account manager,client id`) fills people by primary address, 500 per statement. Fill
never moves an id a record already has, and a company keeps the first it was given. Existing events are applied once
by `backfill-newswireos-client-ids` (job code: paged, resumable, dry run by default).
