# GUARD-4 — The outbound relay: Gmail mail judged by the CRM before it leaves

Owner ask (2026-11-11, #355): Workspace's GUARD-3 rule holds every first-touch outside email that did not come
from the CRM, because Workspace sees headers and cannot tell a rep's own customer from a cold lead — or, the case
that prompted this, a reply on a rep's own old thread to a lead that is now a colleague's (headers say "reply";
the CRM knows whose lead it is). The CRM can see Gmail (GUARD-2) but never stop it. GUARD-4 puts the CRM in the
path: Workspace routes a Sales rep's outside mail to an SMTP relay the CRM runs; the relay judges it with the
guards' own rules and either hands it back to Google to deliver, or bounces it to the rep with the reason.

Decisions (owner, 2026-11-11): every non-CRM outside email from the Sales OU goes through the relay, replies
included; cold mail to someone the CRM does not know is bounced (not relayed and recorded); the host is
`outbound-relay.pinionnewswire.com`.

## The relay (`apps/api/src/relay/`)

One process, the api image with another entrypoint (`node dist/relay/main.js`), compose service `relay` (profile
`relay`, started by a release where `BYLINECRM_RELAY_HOST` is set). No HTTP, no workers, no queues: configuration,
the database clients, the domain-event writer (`OUTBOX_RELAY=0` — the api's outbox delivers what the relay
records) and the relay.

- **Listener** (`RelayServer`, `smtp-server`): port 2525 in the container, `BYLINECRM_RELAY_PORT` (587) on the host,
  STARTTLS with the host's Let's Encrypt certificate (`install-relay-cert.sh` copies it for the `node` user;
  renewals are picked up without a restart). No login: only Google's addresses may connect (`GoogleNetblocks`
  reads `_spf.google.com` at start and hourly; `RELAY_ALLOWED_CIDRS` adds a test address). One message is one
  SMTP transaction and one answer:
    - `250` — judged fine and taken by Google's SMTP relay service (`RELAY_UPSTREAM_HOST`, smtp-relay.gmail.com:587,
      STARTTLS, allowed by this server's IP). The message goes as it came with `X-BylineCRM-Relay: <id>` in front;
      Google signs and delivers it as the user's own mail, so SPF, DKIM and DMARC are unchanged.
    - `550` with the bounce text — refused. Gmail shows the rep the text: which address, whose lead or why it is
      cold, and "open the contact in the CRM and send from there".
    - `451` — the CRM could not decide (database away) or Google's relay would not take it. Google tries again for
      hours; nothing is lost, nothing leaves unjudged. That is the fail-closed choice, with no mail dropped.
    - `554` at connect for anyone but Google; `550` for a message already stamped (a loop), or from an address no
      workspace has a mailbox for; `552` over `RELAY_MAX_BYTES`.
- **Judge** (`RelayJudge`): the sender's mailbox names the workspace (the owner client, since no workspace is
  known yet; everything after runs scoped). A pool or service mailbox's mail is a sequence's or a shared inbox's,
  relayed unjudged, as GUARD-2 and GUARD-3 leave it; so is a CRM send (`X-BylineCRM-Id`, judged at send). For a
  rep's mail the facts are the ones `PoachDetector` reads for a stored message — each envelope recipient's person,
  company, owner and exclusion (`readRecipients`), the workspace's domains, and the thread the `In-Reply-To` /
  `References` ids name as sync stored it (members on it, who wrote before).
- **Rule** (`relayRefusals`, pure, unit-tested): `poachFindings` ∪ `offCrmColdFindings` over those facts. A
  recipient is a refusal when they are another member's lead (and that member is not on the thread) or a customer
  on the exclusions who did not write first — `poach_suspected` — or nobody the CRM knows and nobody outside wrote
  in the thread first — `off_crm_cold`. Members, the workspace's domains and the sender's own leads are never
  refusals. One refused recipient bounces the whole message: the rep sees exactly who and why, and nothing
  half-leaves.
- **Record**: every refused address is a `guardrail_events` row — kind as above, outcome `blocked`, path `relay`
  (new; migration `20261201090000_guard_4_relay_path`, one enum value) — with GUARD-2's and GUARD-3's severity
  ladders over the sender's recent events, and the same notifications: the lead's owner and the reviewers for
  poaching; the reviewers from `medium` for cold mail (a `low` cold bounce is the audit row — the rep saw the
  bounce). The message says who, whom, when and the subject; the body is never read. Dedupe key
  `relay:<Message-ID>:<address>`, so Google's retry of a `451` cannot write twice.

What the relay does not do: judge a message's body or attachments; keep a copy; authenticate anyone; serve a
second Workspace (one host, production's).

## In Google Workspace (admin console, `md@pinionpartners.co`)

Once, after `install-relay-cert.sh production` and a release have the relay listening:

1. **Apps → Google Workspace → Gmail → Hosts → Add route**: name `Byline CRM outbound relay`, single host
   `outbound-relay.pinionnewswire.com` port `587`; Require mail to be transmitted via a secure (TLS) connection,
   Require CA signed certificate, Validate certificate hostname: all on.
2. **Apps → Google Workspace → Gmail → Routing → SMTP relay service → Add**: name `Byline CRM relay return`;
   Allowed senders `Only addresses in my domains`; Only accept mail from the specified IP addresses:
   `169.58.194.188`; Require SMTP Authentication off; Require TLS encryption on. This is how the relay hands mail
   back.
3. **Compliance → Content compliance → `Cold mail must go through Byline CRM`** (the GUARD-3 rule, on the Sales
   OU): keep Outbound, keep the envelope filter (outside recipients only), and change
    - the expressions (ALL of): drop the `In-Reply-To|References` condition (replies go through the relay too);
      keep `(?im)^X-BylineCRM-Id:\s*\S+` not-matching (CRM sends) and `(?im)^Message-ID:\s*<calendar-`
      not-matching (Calendar); add Full headers · Not matches regex · `(?im)^X-BylineCRM-Relay:\s*\S+` (what the
      relay handed back — without this the message would be routed to the relay again);
    - the action: from Quarantine to **Modify message → Change route → `Byline CRM outbound relay`**. Also affect
      internal messages stays off.
4. Try it with one rep first: duplicate the rule, limit its envelope filter to that sender, point the copy at the
   relay, and send from Gmail to an own lead (delivered, with `X-BylineCRM-Relay` in the headers), to a colleague's
   lead (bounced, event on Settings → Guardrails) and to a stranger (bounced). Then change the real rule and delete
   the copy.

Sanity: `openssl s_client -starttls smtp -connect outbound-relay.pinionnewswire.com:587` shows the certificate;
`docker logs bylinecrm-production-relay-1` shows one line per message (`relayed …` / `bounced …`), never a
subject or body. Google's own test is a message from a Sales mailbox to an outside address.

## Failure modes

| What                                         | Effect                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Relay container down or being released       | Google cannot connect; it queues and retries (hours). Nothing leaves unjudged.                                          |
| Database away                                | `451`; same.                                                                                                            |
| Google's relay service refuses               | `451`; same. The sender's address must be in the domain and the server's IP allowed (step 2).                           |
| Certificate expired                          | Google refuses the TLS session (step 1 validates it); same as down. certbot renews; the hook copies; the relay reloads. |
| Rule's `X-BylineCRM-Relay` condition missing | Every relayed message comes back to the relay, which refuses it (`550 … loop`) — the rep gets a bounce. Fix the rule.   |

## Alternatives considered (#355)

Workspace address lists of customer domains: no API, manual, and prospects on free mail cannot be listed. A
quarantine reviewed by hand: that is GUARD-3's phase 1, which is what showed the gap. Starting new threads only
from the CRM: current policy, still true for cold mail; the relay is what makes replies and own-customer mail
from Gmail safe.

Related: GUARD-2 (`PoachDetector`), GUARD-3 (#333, `docs/design-notes/GUARD-3.md`), #354, #355.
