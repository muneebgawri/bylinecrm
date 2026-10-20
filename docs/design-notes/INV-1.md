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

- The NewswireOS side is in review (newswireos#621, pressboard#350). The contract below matches it.

## The contract (final, as built in newswireos#621 / pressboard#350)

Byline calls NewswireOS through `NewswireosVerificationPort`. Production uses the HTTP adapter and tests use
`test/support/fake-newswireos.ts`. A workspace with no NewswireOS link sends every invoice to `needs_review`,
where a person with `invoice:verify` decides.

### 1. Verification lookup (Byline → NewswireOS)

`POST {baseUrl}/api/v1/crm/payment-verification/lookup`

- Auth: `Authorization: Bearer <apiToken>`, a NewswireOS API token with scope `payment_verification:lookup`.
  It is stored in Settings → NewswireOS and sealed with SecretBox.
- Request: `{ "reference", "gateway": "stripe" | "paypal" | "crypto_onchain", "amount_cents", "currency" }`.
  `amount_cents` is the amount expected (the deal amount, or the per-invoice override), and `currency` is lowercase.
  Byline never sends `bank_wire`; those invoices go to `needs_review` without a call.
- Response 200: `{ status, reason_code, canonical_reference, amount_cents, currency, paid_at, already_used, … }`.
    - `status` + `reason_code` are NewswireOS's decision (`VerificationService.decide()`): `verified`
      (`reason_code` null or `UNDERPAID_WITHIN_TOLERANCE`), `invalid` (`NOT_FOUND`, `AMOUNT_MISMATCH`, `REFUNDED`,
      `WRONG_PAYEE`, …), `needs_review` (`PROVIDER_ERROR`, …) or `pending` (`UNDER_CONFIRMED`). Byline treats
      `pending` and anything it doesn't recognise as `needs_review`.
    - `amount_cents` / `currency` are what the **provider** reports (null when not found), not an echo of the
      request. Byline keeps them, and every other field, in `verification_payload` for display. `canonical_reference`
      is also stored, so later webhooks can match on it.
    - `already_used: true` means another release already holds the payment. **Byline treats this as `needs_review`
      with reason `ALREADY_USED`, not `invalid`.** A CRM deal's payment is often the very payment that bought
      a release, so refusing it would be a guess, and uncertainty goes to a person. When the decision is already
      `invalid`, it stays `invalid` with NewswireOS's reason.
- Errors:
    - 401 (bad or revoked token): `needs_review` / `TOKEN_REFUSED`.
    - 403 (token lacks the scope): `needs_review` / `TOKEN_LACKS_SCOPE`. The UI says "token lacks the
      payment_verification:lookup scope".
    - 400 (malformed body): `invalid` / `BAD_REQUEST`, keeping NewswireOS's message.
    - 5xx, 429, network failure or a 10 s timeout: retried with backoff (3 attempts), then `needs_review` / `PROVIDER_ERROR`.
    - A provider (gateway) error is not an HTTP error. It arrives as 200 `needs_review` / `PROVIDER_ERROR`.

### 2. Payment-state webhook (NewswireOS → Byline)

NewswireOS's existing outbound webhook format, posted to `POST {bylineAppUrl}/api/hooks/newswireos/{hookToken}`.
Settings → NewswireOS shows that URL, which can be rotated.

- Secret: minted by NewswireOS (`whsec_…`, any length) when the hook is added there, then pasted into Byline
  Settings → NewswireOS. Byline stores it sealed and never generates one.
- Headers:
    - `x-webhook-signature: sha256=<lowercase hex HMAC-SHA256 of the raw body>`. Byline strips the prefix and
      compares in constant time. A wrong or missing signature gets 401, and an unknown hook token gets 404.
    - `x-webhook-id` and `x-webhook-event` are also sent. Byline reads the body's `id` and `event_type`.
- Body: exactly `{ id, event_type, occurred_at, data }`.
- `data`: `{ gateway, reference, references[], amount_cents | null, currency, reason_code, refunded_amount_cents? }`.
  Byline matches an invoice on `gateway` plus any of `references[]` (and `reference`), compared with the stored
  reference or the stored canonical reference, within the hook's workspace.
- Dedup: Byline remembers each applied `id` for 7 days. A redelivery is answered `{ "result": "duplicate" }`
  and not applied again. Applying is idempotent anyway.
- Events:
    - `payment.refunded`: `refunded_amount_cents` is the **running total** refunded. `amount_cents` may be null,
      for example on PayPal. If the total is below the invoice's amount, it is a partial refund: the invoice stays
      `verified`, counts net, and Byline emits `invoice.refunded`. If the total is the whole amount or more, or
      the field is missing, the invoice becomes `invalidated` and Byline emits `invoice.invalidated`.
    - `payment.disputed`: a chargeback. The invoice is always `invalidated`.
    - `payment.verified`: finance verified the payment in NewswireOS. `reason_code` is null or
      `UNDERPAID_WITHIN_TOLERANCE`, and Byline keeps it on the invoice. A `needs_review` invoice becomes `verified`.
    - There is no ping event. Any other `event_type` is answered `{ "result": "ignored" }`.
- Answers: 200 `{ "result": "applied" | "unmatched" | "ignored" | "duplicate" }`. NewswireOS retries any non-2xx answer.
