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

**For BylineAI** (not changed from here): move these three into its `packages/contract` and have the connector
import them, so both repos depend on one definition.

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
- Phone is not taken: BylineAI sends E.164 and the CRM keeps a number with its country, which the payload does not
  say. Left for when it matters.

**Settings > BylineAI** (`GET / PUT / DELETE /integrations/byline`, `workspace:admin`): the secret (sealed with
`SECRETS_KEY`, never shown back; needed the first time, kept when left out), the round-robin members (must be in the
workspace), the webhook URL to copy, and the last delivery's result.
