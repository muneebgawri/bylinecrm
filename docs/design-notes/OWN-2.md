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

## OWN-2b: sync, required companies, and the screens

- **Calendar sync follows the rule.** A lead the sync finds at a company another member owns is saved for that
  owner, not the meeting's host. It is recorded as a forced transfer from the host, so the owner is told, and it does
  not count as the host's new lead. An unowned person met at such a company becomes the company owner's too.
  Suggested leads a member adds by hand were already refused by name (they run as the member).
- **The Twenty importer still keeps Twenty's owners.** Twenty is the migration's source of truth; rewriting its owners
  on the way in would lose them. What disagrees shows on the Ownership page instead.
- **Managers still place records where they choose.** They are the ones who resolve conflicts.
- **A deal is with a company.** A member or API key creating a deal names a company, or a point of contact who is at
  one (`422 companyId` otherwise), and cannot clear a deal's company. The importer brings deals as the source had
  them. The New deal dialog marks Company as required.
- **Ownership (Settings, `record:transfer`)** lists every person and open deal held by someone other than its
  company's owner, with **Move to <owner>** per row and **Move all to their owners**
  (`POST ownership/conflicts/resolve`: a forced transfer each, and a person not yet linked to the company is linked).
  Rows the report no longer lists come back as `skipped`.
- **Other domains** is a card on the company record: the owner or a manager adds and removes them; everyone else
  reads them. Compared by registrable domain (OWN-2c, below).

## OWN-2c: one company per registrable domain

The owner (2026-10-20): `example.com` and `www.example.com` are one company — and so is any subdomain. A company's
domain is now its **registrable domain** by the Public Suffix List (`tldts`, MIT, API only — kept out of the web
bundle):

| Given                                                           | Stored / compared as                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `https://www.Acme.com/about`, `uk.acme.com`, `mail.eu.acme.com` | `acme.com`                                                                                               |
| `shop.acme.co.uk`                                               | `acme.co.uk`                                                                                             |
| `acme.github.io`, `acme.myshopify.com`                          | themselves: the list counts `github.io` and `myshopify.com` as suffixes, so each name is its own company |
| `co.uk`, an IP address                                          | refused (`400`): no company's domain                                                                     |

- **Every writer stores it so** — the routes and the Twenty importer — and a company's other domains too. A second
  company on the same registrable domain is `409 conflict.company_owned`.
- **People are matched the same way:** `dana@eu.acme.com` is at `acme.com`.
- **Existing rows.** The migration strips `www.` in SQL. Subdomains need the Public Suffix List, so a one-off command
  does the rest after deploy (dry run first, then `--apply`; it prints every change and a summary, zero included):

    ```bash
    node dist/cli/normalise-company-domains.js          # what it would change
    node dist/cli/normalise-company-domains.js --apply
    ```

    A row whose registrable domain another company already has is left as it is: two records of one company. Settings →
    Ownership lists each as **Same company saved twice**, for a person to merge or delete (computed in code, since SQL
    has no suffix list). Until the command runs, lookups still match a `www.` row under its registrable domain.

## Not here

- **A per-workspace switch for the rule.** It judges only new writes, and the Ownership page clears what predates it.
- **"Request a transfer"** from the owner: not asked for; the owner can already hand records on (OWN-1).

## Tests

`test/cross-tenant/company-ownership.spec.ts` (FR-CRMS-20 in the titles), with account managers on an own-scoped
role: the owner's person is linked by domain; another member is refused by name though they cannot see the company;
free mail is unaffected; hand-to-owner saves for the owner and tells them; a duplicate company domain and an other
domain are refused; a manager places a record anywhere and reads the report; a deal takes its contact's company and
is the company owner's.
