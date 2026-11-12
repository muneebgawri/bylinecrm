# OWN-LOOKUP — Who owns this person or company, for an integration

NewswireOS review, PNW-1414 (2026-11-12). BylineCRM only **pushes** to NewswireOS today: an ownership change
(NewswireOS FR-CRM-6a) and a won deal (FR-CRM-6b). A client who signs up in NewswireOS, and whom a salesperson here has
been working, never reaches it. NewswireOS now **asks**, once for each new sign-up and when someone presses "Check CRM",
and shows the salesperson on its Clients and Unassigned lists. The contract is NewswireOS doc 11, "v2 → BylineCRM: who
owns this person or company".

## The endpoint

`GET /api/w/:workspaceId/integrations/owners/lookup?email=<address>[&domain=<company domain>]`, with an API key whose
role holds **`record:owner_lookup`**. No default role holds it: an admin grants it to the role of NewswireOS's key, as
for `mail:service_read`. Read only: nothing is claimed, written or audited.

| field        | meaning                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| `found`      | a person with the address, or a company at the domain, exists                          |
| `match`      | `person` or `company`: which record's owner answered; `null` when nothing was found    |
| `recordId`   | that record                                                                            |
| `recordName` | the person's or company's name                                                         |
| `owner`      | `{ email, name }` of the owning member, by sign-in email; `null` when nobody owns them |

`400` for a malformed address; `403` for a key without the capability.

## The rule is OWN-2's, read across the workspace

`OwnerLookupService` answers the way the recipient guard (GUARD-1) decides whose lead an address is, and reads across
the key's owner scope, as the guard does:

1. the **person** with the address, primary or additional (`person_addresses`), the earliest saved; their owner;
2. else, or when the person is nobody's, the **company**: the person's own, else the one at the domain (the `domain`
   asked about, else the address's registrable domain unless it is free mail). A company's owner owns every person at
   it (OWN-2); a company with no owner is its first person's (OWN-2d).

A member who has left, a shared mailbox (outreach@) or a dormant owner (OWN-2f) owns nothing: the answer is
`owner: null`, as the guard reads it.
