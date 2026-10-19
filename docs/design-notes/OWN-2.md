# OWN-2 — Company-domain ownership (#201)

Issue #201; proposal `PROPOSAL-ownership-and-guardrails.md` §3. Owner ask (2026-10-19): deals are per company, not
per lead; the first person to save and work a prospect at a company owns every later lead from it; another employee
saving a lead with the same email domain or company is warned and blocked, and offered to hand it to the owner.
FR-CRMS-20. Builds on OWN-1 (#200): the hand-over is a transfer.

## The rule

**The member who owns a company owns every person at it and every deal with it.** A company is found by its own
`domain` or one of its other domains (`company_domains`, new); a person by their primary address's domain, free mail
(gmail, outlook, …; the enrichment list) left out.

| Write                                                                        | Result                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Person saved by the company's owner (or anyone, for an unowned company)      | Linked to the company by domain when no company was named                                      |
| Person saved by anyone else at an owned company — by domain or by naming it  | `409 conflict.company_owned`, `details` `{ companyId, companyName, ownerMemberId, ownerName }` |
| The same, with `handToOwner: true`                                           | Saved for the owner, at the company; a `forced` transfer from the saver tells the owner        |
| A person's company changed, or a company-less person given an address at one | Held to the same rule                                                                          |
| Company saved with a domain another company has (own or other)               | `409 conflict.company_owned`, naming that company's owner                                      |
| Deal created with no company but a point of contact                          | The contact's company                                                                          |
| Deal with (or moved to) another member's company                             | `409 conflict.company_owned`                                                                   |

**Who it binds:** members and API keys without `record:transfer`. A manager places records where they choose; a job
(Gmail/calendar sync, the Twenty importer) acts for the workspace and is not refused — it would otherwise fail an
import on data that predates the rule. The backfill report is how a manager cleans that data up.

**Own-scoped members are told whose it is.** Who owns a domain is read across the workspace, outside the caller's
owner scope; the 409 names the company and its owner, and nothing else of it. That is the point: an account manager
who sees only their own records must learn that a lead is already someone's.

## Routes

- `POST people { …, handToOwner: true }` — the hand-over (above).
- `GET / POST companies/:id/domains`, `DELETE companies/:id/domains/:domain` — a company's other domains; the
  company's owner or a holder of `record:transfer`. Stored lower case, without scheme or `www.`.
- `GET ownership/conflicts` (`record:transfer`) — the backfill report: people at an address whose company another
  member owns, and people or open deals linked to a company another member owns. At most 1000 rows.

## Web

- **Add person** (lists): a `409 conflict.company_owned` reads "Ortiz Ltd is Ana Ortiz's. Its people and deals are
  theirs…", with **Save for Ana Ortiz**, which resubmits with `handToOwner`.
- **The owner field** on every record (OWN-1's second half): a manager picks a new owner and the record, with its
  unit, moves at once; the owner has **Hand on…** (pick a member, optional reason), and the receiver; an open offer
  shows under the field with **Accept / Decline** for the receiver and **Take back** for the proposer or a manager;
  anyone with `record:write` claims an unowned record; everyone else sees who owns it and why they cannot change it.
  A completed transfer reads "changed the owner → Ben Ade" on each moved record's timeline.

## Not here

- **Deals without a company stay allowed.** The proposal made a company required for a new deal. Existing API
  clients, the Twenty importer and the deal board's quick-add all create deals without one, so requiring it would
  break them; the contact's company is filled in instead. Making it required is an owner decision.
- **No switch to turn the rule on.** It only judges new writes (a create, a company or address change), so existing
  records are untouched until someone edits them; the report lists them first. A per-workspace switch can follow if
  the cutover needs one.
- **A UI for other domains and for the report** — API only for now.
- **"Request a transfer"** from the owner (the proposal's second action): not asked for; the owner can already hand
  records on (OWN-1).

## Tests

`test/cross-tenant/company-ownership.spec.ts` (FR-CRMS-20 in the titles), with account managers on an own-scoped
role: the owner's person is linked by domain; another member is refused by name though they cannot see the company;
free mail is unaffected; hand-to-owner saves for the owner and tells them; a duplicate company domain and an other
domain are refused; a manager places a record anywhere and reads the report; a deal takes its contact's company and
is the company owner's.
