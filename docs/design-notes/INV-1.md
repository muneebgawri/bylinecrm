# INV-1: invoices on a deal, verified by NewswireOS (#206, FR-CRMS-19)

Spec: `PROPOSAL-ownership-and-guardrails.md` §2. The CRM checks a payment by calling NewswireOS. It does not
copy NewswireOS's verification logic (D-239).

## What the CRM does

- `deal_invoices`: `(workspace, gateway, reference)` is unique, so one payment belongs to one deal. RLS is
  `workspace_isolation`, and the app has no DELETE. The amount defaults to the deal's amount and can be
  overridden for a partial payment. An optional receipt is an ordinary attachment on the deal (`attachmentId`).
- States are `verifying` → `verified` | `invalid` | `needs_review`, and `verified` → `invalidated` on a refund or
  chargeback. Uncertainty never passes: `pending`, `needs_review`, a missing decision, a refused token, or
  NewswireOS staying down after 3 tries all become `needs_review`. Each sends an `invoice_needs_review`
  notification to every holder of `invoice:verify` and every admin.
- An `invalid` reference can be entered again on the same deal (for example with a corrected amount). That
  re-asks NewswireOS. Any other duplicate gets `409 INVOICE_TAKEN`. The message never says which deal holds it.
- A workspace with no NewswireOS link, and every `bank_wire` invoice, goes straight to `needs_review`.
  Holders of the new capability `invoice:verify` (in the manager defaults) verify or refuse those by hand.
  This is the working default until NewswireOS ships the token endpoint.
- Verification runs as a BullMQ job (`invoice-verification`, worker flag `INVOICE_WORKER`). It goes through
  `NewswireosVerificationPort`, which has an HTTP adapter and a fake in `test/support/fake-newswireos.ts`.
- Events: `invoice.verified`, `invoice.refunded` and `invoice.invalidated` have the object `invoice`, target
  the deal, and carry an `invoice` payload (`amountMinor`, `refundedAmountMinor`, `covers`, and the rest).
  `invoice.verified` puts the deal in `related` only when the deal's verified invoices in its currency, net of
  refunds, cover its amount (or when the deal has no amount). So a stage rule on `invoice.verified` moves the
  deal once it is fully paid.
- Stage rules may now target a won or lost stage (decided for INV-1). Such a rule closes the deal through the
  same path a member's close takes (`StageMoveService.move` with a close payload, then `announce`): it sets
  `closedAt`, writes history attributed to the rule, emits `deal.won`/`deal.lost`, and so reaches webhooks and
  the timeline. The deal keeps its amount, and a rule-made lost close has no lost reason. Only open deals are
  moved by rules: a closed deal is never reopened by one. "Fully paid → Won" is a rule on `invoice.verified`
  to the Won stage.
- Partial refunds (decided for INV-1): `refunded_amount_minor` stores NewswireOS's running total. A refund
  smaller than the invoice keeps it `verified`, shows a "Partially refunded" badge, and counts it net
  (`amount − refunded`) toward the deal's coverage. It emits `invoice.refunded` with both amounts. A refund of
  the whole amount, or any chargeback, makes the invoice `invalidated` as before. When a refund or chargeback
  leaves the deal's verified invoices short of its amount, admins and holders of `invoice:verify` get an
  `invoice_coverage_lost` notification. A won deal is not reopened.
- Settings > NewswireOS (an admin page) holds the base URL and the API token (sealed with SecretBox, never
  shown), the hook secret (sealed), and a rotatable hook URL, in the same shape as Slotline (CAL-2).

## Open questions

- NewswireOS has no external token-scoped endpoint or outbound webhook yet. The contract below is
  the assumption. The NewswireOS side is being built separately.

## The contract (v1)

Byline codes against this through a port (`NewswireosVerificationPort`). The HTTP adapter is used in
production and a fake is used in tests. Until NewswireOS ships it, a workspace with no NewswireOS link
sends every invoice to `needs_review`, and someone with `invoice:verify` verifies it by hand. That manual
path is the default that works today.

Naming follows the internal `POST /api/workspaces/:slug/payment-verification/lookup`
(`amount_cents`, `status` + `reason_code`, `VerificationService.decide()`), but this is a **separate
token-scoped endpoint**. The token identifies the NewswireOS tenant, so the path has no slug.

## 1. Verification lookup (Byline -> NewswireOS)

`POST {baseUrl}/api/v1/crm/payment-verification/lookup`

Byline's per-workspace setting holds `baseUrl` (an http(s) origin) and `apiToken`, sealed at rest with
Byline's SecretBox.

Headers:

- `Authorization: Bearer <apiToken>`: a NewswireOS API token bound to one tenant, with scope
  `payment-verification:lookup` (equivalent to `payment_proof:verify` for this route only).
- `Content-Type: application/json`, `Accept: application/json`

Request:

```json
{ "reference": "pi_3P...", "gateway": "stripe", "amount_cents": 150000, "currency": "usd" }
```

- `gateway`: `stripe` | `paypal` | `crypto_onchain`. Byline never sends `bank_wire`, because it goes straight to needs_review.
- `amount_cents`: integer minor units > 0 (the deal amount, or a per-invoice override for a partial payment)
- `currency`: ISO 4217, lowercase

Response 200:

```json
{
    "status": "verified",
    "reason_code": null,
    "gateway": "stripe",
    "canonical_reference": "pi_3P...",
    "amount_cents": 150000,
    "currency": "usd",
    "paid_at": "2026-10-20T10:00:00Z",
    "already_used": false
}
```

- `status`: `verified` | `invalid` | `needs_review` | `pending`, exactly as `decide()` returns it.
    - `verified` (reason_code may be `UNDERPAID_WITHIN_TOLERANCE`): Byline attaches the invoice.
    - `invalid` + reason_code (`NOT_FOUND`, `NOT_SUCCEEDED`, `INVOICE_UNPAID`, `REFUNDED`, `WRONG_PAYEE`,
      `AMOUNT_MISMATCH`, `REUSED`, …): Byline refuses it and shows the reason.
    - `needs_review` (`PROVIDER_ERROR`, `INVOICE_LINK_UNRESOLVED`, `CONFIRMATIONS_UNKNOWN`, …) and `pending`
      (`UNDER_CONFIRMED`): Byline shows a "waiting for finance" badge and notifies holders of `invoice:verify`.
      A person can re-check it later.
- Byline stores every other field as given, for display. It reads `canonical_reference` to match webhooks later.
- `already_used`: whether NewswireOS already has this payment on a release. Informational only.
  Byline enforces its own one-payment-one-deal rule.
- Nothing is persisted on the NewswireOS side.

Errors:

- 401/403: Byline sets `needs_review` / `TOKEN_REFUSED`.
- 400/422: Byline sets `invalid` / `BAD_REQUEST`, keeping `{ "message": "..." }` when present.
- 5xx, network failure or timeout (10 s): Byline retries with backoff (3 attempts), then sets
  `needs_review` / `PROVIDER_ERROR`.

## 2. Payment-state webhook (NewswireOS -> Byline)

`POST {bylineAppUrl}/api/hooks/newswireos/{hookToken}`. Byline's Settings > NewswireOS page shows the
full URL. An admin gives NewswireOS that URL and the same shared secret (16-200 chars) entered in Byline.

Headers:

- `Content-Type: application/json`
- `X-NewswireOS-Signature: <lowercase hex HMAC-SHA256 of the raw body, key = shared secret>`

Body:

```json
{
    "id": "evt_01J...",
    "type": "payment.refunded",
    "occurred_at": "2026-10-21T09:00:00Z",
    "data": {
        "gateway": "stripe",
        "reference": "ch_9",
        "references": ["ch_9", "pi_9", "in_77"],
        "amount_cents": 150000,
        "refunded_amount_cents": 50000,
        "currency": "usd",
        "reason_code": "REFUNDED"
    }
}
```

Types:

- `payment.refunded`: a refund. `data.amount_cents` is the payment's amount and `data.refunded_amount_cents`
  is the **running total** refunded on it so far (not this refund alone), so a replay is harmless. If the total is
  less than the invoice's amount, it is a partial refund: the invoice stays `verified`, counts net, and Byline
  emits `invoice.refunded`. If the total is the whole amount or more, or `refunded_amount_cents` is missing,
  the invoice becomes `invalidated` and Byline emits `invoice.invalidated`.
- `payment.disputed`: a chargeback or dispute opened. The invoice is always `invalidated`, whatever the amount.
- `payment.verified`: optional. Finance verified the payment in NewswireOS, so a `needs_review`
  invoice becomes `verified`.
- `ping`: Byline answers `{ "result": "ping" }`.
- Any other type: Byline answers `{ "result": "ignored" }`.

Byline matches on `gateway` plus any of `reference` / `references[]` against the stored reference, or the
canonical reference NewswireOS returned at lookup, within the hook's workspace.
Answers: 200 `{ "result": "applied" | "unmatched" | "ignored" | "ping" }`; 401 for a bad or missing signature; 404 for an unknown
token. Replays are harmless. NewswireOS should retry a non-2xx answer with backoff.
