# BYL — BylineAI, connected rather than folded in (#207, #208)

Proposal `PROPOSAL-ownership-and-guardrails.md` §8. BylineAI keeps discovery, extraction, review and its paid
enrichment layers; the CRM gets one receiver for its leads (BYL-1) and asks it for enrichment and verification
through the existing ports (BYL-2). The wire has one definition: `@byline/contract` (`packages/contract`).

## `@byline/contract`

Mirrors `bylineai/packages/contract` (same name): the HMAC schemes and `StandardizedContact`. BylineAI's package
validates `StandardizedContact` with Zod 3; the CRM runs Zod 4 and never receives one, so only its type is mirrored.
Added here, because BylineAI's package does not have them yet (they live inline in its WEBHOOK connector):

- `BylineLeadPayload` / `parseLeadPayload` — the connector's `leadEnginePayload` (`lead_id = Contact.id`, `email`,
  optional `first_name`, `last_name`, `phone`, `company_name`, `job_title`, `country`, `linkedin_url`, `source_url`,
  `source_key`, `natural_id`, `pr_title`, `discovered_at`; absent rather than null).
- `BylineLeadResponse` — `{status: ingested|duplicate, personId}` or `{status: rejected, reason}`; BylineAI reads the
  body, not the HTTP code (`outcomeFromResponse`).
- `signWebhook` / `verifyWebhook` — the connector's signature: `x-byline-signature: sha256=<hex HMAC-SHA256(secret,
raw body)>`, no timestamp (unlike the ingest scheme, `signPayload`/`verifySignature`, which is mirrored as is).

BylineAI took these into its own `packages/contract` (pinionpartners/bylineai#3) under the same names; its connector
imports `signWebhook`. Both suites pin one vector (secret `byline-test-vector-secret`, `byline.spec.ts`).

## BYL-1 — the lead receiver

`POST /api/w/:workspaceId/inbound/byline` — set BylineAI's `BYLINE_WEBHOOK_URL` to it and `BYLINE_WEBHOOK_SECRET` to
the workspace's secret. Today Lead Engine on Twenty receives these; cut over with the Twenty importer (doc 48 §11).

- **Gate.** A tenant path no member calls: `@SignedInbound(reason)` lets it past the workspace and capability guards
  (the router-walking spec lists every such route). The owner client reads that workspace's sealed secret and nothing
  else; the raw body must verify in constant time, or `401` and nothing is read. An unknown or unlinked workspace is
  `404`. Refusals are rate-limited per client address (30 per 10 min).
- **Answer.** `200 {status}` in BylineAI's shape; a payload that is not a lead is `rejected` with a reason.
- **Idempotent on `lead_id`.** `byline_leads (workspace_id, lead_id)` is unique; a redelivery (or a concurrent one
  that lost the race) is `duplicate` with the same `personId`.
- **Person.** Found by primary address, or made. One already in the CRM keeps its owner and company, has blank name,
  job title and country filled, and is answered `duplicate` (the CRM already holds that lead). One someone removed is
  not brought back (`rejected`), as calendar sync does.
- **Owner (OWN-2).** The owner of the company the address's registrable domain belongs to (own or other domain);
  else the next member on the round-robin list still in the workspace — who is also given the company (found unowned
  or made), so the company's next lead follows them; else nobody: the person waits unowned (**the Leads queue** —
  anyone with `record:write` claims an unowned record, OWN-1). The turn is a counter on the settings row, incremented
  in the lead's transaction, so concurrent leads are dealt one after the other.
- **Company.** Found by domain, else made from it (named `company_name`, else the domain). Free mail has no company.
- **Source.** `byline:<source_key>` (lower case, `[a-z0-9_.-]`), or `byline` when BylineAI names none.
- It runs as a job for the workspace (`actor: sync`), so OWN-2's refusal binds it no more than calendar sync.
- **Phone (BYL-3).** BylineAI sends `country` (ISO alpha-2) and the phone in E.164 when it could parse it, else as it
  holds it. E.164 is split at its calling code (a shared one — `+1`, `+7`, `+44` — goes to the lead's country);
  dialled digits take the lead's country; anything else (letters, an extension, no country) is kept as sent on the
  lead (`byline_leads.phone_raw`) rather than dropped. A person already in the CRM gets the phone only when it has
  none.

**Settings > BylineAI** (`GET / PUT / DELETE /integrations/byline`, `workspace:admin`): the secret (sealed with
`SECRETS_KEY`, never shown back; needed the first time, kept when left out), the round-robin members (must be in the
workspace), the webhook URL to copy, and the last delivery's result.

## BYL-2 — enrichment and verification from BylineAI

The CRM asks BylineAI by address with the workspace's API key (`x-api-key`, as BylineAI's `ApiKeyGuard` reads it).
`BylineApi` is the port (`byline/byline-api.port.ts`); `BylineApiHttp` the adapter (10 s timeout); the suites use
`test/support/fake-byline.ts`.

- **Link.** The same Settings > BylineAI page: BylineAI's site origin (its nginx sends `/(enrichment|verification)/
<email>` straight to its API) and an API key with BylineAI's scoped `lookup` role (`BYLINE_API_KEYS="<key>:lookup"`;
  sealed, never shown back; needed with a first address, kept when left out; `baseUrl: null` unlinks the API), and whether
  verification goes to BylineAI. A link may be the webhook, the API, or both; a link with only the API refuses
  deliveries as an unlinked workspace does.
- **Enrichment** (P4-2's `Enricher`, FR-CRMS-15): source `byline`, a sixth switch on Settings > Enrichment. A
  person is asked by their address (country — BylineAI's `avatarUrl` is always null); a company by its first person's
  (name, domain, logo, LinkedIn). A contact BylineAI holds (confidence above a vendor-only match's fixed 0.8) ranks
  2; a vendor-only match ranks 1, with the free sources. A
  workspace with no API link is not asked (`Enricher.available`, new and optional, is checked before asking).
- **Verification** (FR-CRMS-16 "vendor behind an interface"): the `Verifier` in use is `BylineVerifier`. With the
  switch on it asks BylineAI (its Reacher pool, on its own box — the CRM never probes SMTP), source `byline`;
  otherwise the free layer answers, as before. `Verifier.verify` now takes the asking workspace.
- **Reasons.** BylineAI's `invalid_format`, `no_mx`, `mailbox_not_found`, `catch_all`, `disposable`, `role`,
  `mailbox_exists` map to the CRM's reasons (two new ones: `mailbox_not_found`, `catch_all`); the provider
  (`free`, `reacher`, `smtp-probe`, `zerobounce`, `hunter`, `emailable`) is named in the message.
- **Budgets are BylineAI's.** A `402`/`budget_exhausted`, `429`/`rate_limited`, `503`/`unavailable` (its vendor pool
  down), a refused key or an outage becomes a `BylineApiError` with BylineAI's words; Nest's extra `statusCode`,
  `timestamp`, `path` are ignored. Enrichment records each fact `failed` with that note; verification answers from
  the free layer and says why BylineAI did not, so a spent budget never stops a workspace's sends. A rate limit or an
  outage is **retryable**: that free answer is stored as `free:fallback` and goes stale after an hour, so BylineAI is
  asked again at the next check; a spent budget or a refused key is not, and the free answer stands as usual.

BylineAI implemented `GET /enrichment/:email` and `GET /verification/:email` in pinionpartners/bylineai#3 with the
shapes in `@byline/contract` (`api.ts`). An enrichment answer that failed is asked again on _Enrich now_ or at the
workspace's re-ask age, as for every source.
