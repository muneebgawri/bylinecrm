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
    4. No open deal → `created_deal`: a deal is made for the payment (the record's company and contact, the record's
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
