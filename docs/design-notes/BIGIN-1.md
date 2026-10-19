# BIGIN-1 — A direct, one-way sync from Zoho Bigin (FR-CRMS-25)

Until now Bigin reached BylineCRM only indirectly: a Python job (`twenty-bigin-sync`) pulled Bigin into Twenty,
and the Twenty importer (P4-4) pulled Twenty into BylineCRM. BIGIN-1 reads Bigin directly. The Twenty importer
keeps running for Twenty-native data; the two meet on the same records (below), never duplicate them.

It is the Twenty importer's shape, on purpose — same run row, links, page transactions, savepoints, report,
schedule, backoff and admin mail — so this note says only what differs. Read `P4-4.md` first.

## What is read, and where it lands

| Bigin module (`/bigin/v1/<Module>`) | Lands as                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Accounts`                          | Companies: `Account_Name`, the registrable domain of `Website` (OWN-2c's `companyDomain`), the billing address.                                                                                                                                                                                                                                                       |
| `Contacts`                          | People: names, `Email` (+ `Secondary_Email`), `Phone`/`Mobile` when written with an international prefix (Bigin's phones are free text; without a calling code there is no country), `Title`, `Mailing_City`, the company through `Account_Name`, `source = bigin`, `PR_LINK` as the `pr_link` custom field (the key the Twenty importer uses for Twenty's `prLink`). |
| `Deals`                             | Deals in the default pipeline: `Deal_Name`, `Amount` (major units → minor, the workspace currency), `Closing_Date`, company (`Account_Name`) and point of contact (`Contact_Name`).                                                                                                                                                                                   |
| `Notes`                             | Notes on their parent (`$se_module` + `Parent_Id`: Contacts, Accounts, Deals/Potentials/Pipelines), `Note_Content` as rich text. A note whose parent is not here is _skipped_.                                                                                                                                                                                        |

`Account_Name`/`Contact_Name`/`Parent_Id` are polymorphic (null, an id, or `{ id, name }`); `lookupId` reads all three.
Bigin ids are kept bare: the CSV export (and so Twenty's `biginrecordid`) prefixes `zcrm_`, the API does not —
`plainBiginId` strips it wherever ids are compared.

**Owners.** `Owner` is `{ name, id, email }`; the email (lower-cased) is matched to a member's sign-in address, as
the Twenty importer matches members. The owner is set **on create only**: who owns a record here is BylineCRM's
business once it exists (OWN-1 transfers). With the accounts option (#184's, same role picker semantics via the
API) an owner who is not a member gets an account and a seat before the page is written; nothing is mailed. The
screen does not offer the option yet (the API does; a scheduled run uses the saved choice).

**Stages.** Bigin's `Stage` is matched to the default pipeline's stage names, case-insensitively. "Closed Won" and
"Closed Lost" with no stage of that name go to the pipeline's won and lost stage. Any other unknown stage goes to
the first open stage and the raw stage is listed in the run report (`unknownStages`) — the importer never adds
stages (unlike Twenty's, which mirrors Twenty's enum). A closed deal is created open and closed through
`StageMoveService.move`, so it has its history and event.

**Precedence (local edits).** The #185 rule, with Bigin's `Modified_Time`: a field edited here after Bigin last
modified the record keeps BylineCRM's value and the record counts as a conflict with the field named.

**The company rule and "a deal needs a company".** Imports run as jobs with the `import` actor and no member, so
`company-ownership.ts` (`isCaller`/`governed`) does not apply to them — unchanged.

## Idempotence and cross-source dedup

`bigin_import_links (workspace, module, bigin id) → (local type, local id)`. A record not yet linked is matched,
in order:

1. **The record the Twenty importer made from the same Bigin record** — its `biginrecordid` custom value (with or
   without `zcrm_`), looked up a page at a time (`import-common/cross-source.ts`, a partial expression index per
   table on `custom->>'biginrecordid'`);
2. a person by primary address / a company by registrable domain (restoring a trashed one), as P4-4 does;
3. else created.

The reverse holds in the Twenty importer: a Twenty company, person or deal not yet linked whose `biginrecordid`
names a Bigin record the Bigin importer linked is **merged** into that record (`localLinkedFromBigin`). Either
importer may run first; one Bigin record is one BylineCRM record. The Twenty importer's company match now uses
the registrable domain too (it compared the bare host, which missed `shop.acme.com` vs `acme.com`).

## Reused Contacts (never overwrite one person with another)

Bigin caps contacts, so the team edits an existing Contact into a different person; one Bigin id has held several
real people. On every update of a linked Contact, `isContactReused(before, after)` (pure, unit-tested) decides:

- **same person** — the primary email is unchanged (case and whitespace aside), or there was none before (or is
  none now);
- **reused** — the primary email changed to another address **and** the name changed or the address's registrable
  domain did.

`before` is what Bigin held when last read (the link's `snapshot`), or the person's current name/email for a link
made before snapshots. On reuse: the earlier person is left untouched (it is the earlier lead) and gets a note
"This Bigin contact was reused for another person on <date>"; the new identity becomes a person of its own
(matched by address first, else created with Bigin's owner); the link moves to them; `bigin_contact_reuses`
records workspace, Bigin id, previous and new person, the change instant (the Contact's `Modified_Time`) and the
before/after name and email. Deals and notes resolve a reused Contact **by when they were made in Bigin**
(`Created_Time`): after the change, the new person; before it, the person the Contact held then. The run report
counts reuses per module (zero included); Settings → Import from Bigin lists them (`GET reuses`). Reuses that
happened before this sync existed are reconstructed by the reconcile below.

## Reconciling reuses that already happened (FR-CRMS-26)

Before this sync, the old Bigin → Twenty job wrote a reused Contact over the earlier person — usually the new
_name_ with the old _address_ (e.g. "Kim Gifford" at `support@pressreleasesubmit.com`) — and BylineCRM imported those
mixed rows from Twenty. 1,631 of 29,578 contacts changed person in the last 30 days of the old logs alone.

`node dist/cli/reconcile-bigin-reuse.js <workspace-slug> [--logs <file.jsonl>] [--apply]` (owner connection, a
Nest application context with no workers or relays of its own) runs `BiginReuseReconciler`:

1. **History per Bigin id, oldest first**, read in bulk (never one request per person): Twenty's `people`
   (who carries which `biginrecordid`) and `timelineActivities` (`person.updated` entries whose diff touches
   `name` or `emails`), through the workspace's stored Twenty connection and the importer's HTTP client; the old
   job's log rows (`{ biginId, ts, email, firstName, lastName }`); Bigin's current record, read through the
   Bigin client when connected, as the latest identity.
2. **Splitting** (`identityHistory`, pure and unit-tested): the first person is the earliest "before" Twenty
   recorded, with the earliest address the history shows — else the holder's, the stale address the old job
   kept. Each Twenty change starts a group that the logs and Bigin's record after it complete (the old job's
   name change and the address it never wrote are one change). Groups are split with the sync's own
   `isContactReused`. A name change with the same address, a change with no address to compare, an earlier
   identity with no address of its own, or a latest address another person already has is **not split** — it
   is printed for review.
3. **Applying, per Contact, in one transaction**: the holder (the Bigin link's person, else the person imported
   from the Twenty person carrying the id) becomes the latest identity; each earlier identity becomes a person
   (matched by address first, restored if trashed; else created with the company of its registrable domain,
   the holder's owner, source "Bigin (reused contact)") with a note explaining the split; notes and tasks on the
   holder made before the change instant, and deals it is the point of contact of, move to the earlier person.
   "Made" is when Twenty created them (an imported record's own `createdAt` is the import's); a record made here
   uses its own. Each split is a `bigin_contact_reuses` row with `source = reconcile`. Every write goes through
   the record services as the import, with its domain events — the mail sync re-points messages to whoever has
   the address now (`email.linked`), the timeline and webhooks see the changes. Nothing is deleted.
4. **Dry run by default**: each Contact's change is made and rolled back, so the counts are exact. **Idempotent**: a
   Contact with a `reconcile` row is not reconciled again. The output is, per Contact, before → after and what
   moved; the review list; and totals per kind, zero included.

Owner steps: deploy, extract the log rows from the old job's logs, run without `--apply`, read the review list,
then run with `--apply`.

## Running, and the cursor

A BullMQ job per run on the `bigin-import` queue, driven by the importers' worker flag (`TWENTY_IMPORT_WORKER`;
no new environment variable, nothing read at boot — `check-env` is untouched and a deployment without Bigin starts
as before). One queued or running run per workspace (partial unique index).

- **Reading.** `GET <api>/bigin/v1/<Module>?sort_by=Modified_Time&sort_order=asc&per_page=200&page=N` with
  `If-Modified-Since`; `304`/`204` are an empty page. Instead of paging deep (Zoho refuses past 2,000 records), a
  pass moves its _window_: after a page, the next request is `If-Modified-Since` a second before the page's latest
  record, page 1; ids already read in the overlapping second are skipped. A record modified mid-run moves to the
  end instead of shifting pages under the pass.
- **Tokens.** A refresh-token grant at `<accounts>/oauth/v2/token`, cached until five minutes before expiry (Zoho
  limits refreshes); a `401` refreshes once; Zoho's `200 { error }` is a refused grant. Secrets never appear in a
  message or log.
- **The cursor rule** (from the Python job's `cursor_policy.py`, whose earlier "advance only when clean" rule
  deadlocked it for months): per module, on the settings row (`cursors`), advanced **past everything that
  succeeded, never past the oldest record that failed** — and written with every page, so a killed run keeps what
  it did (to its high-water mark). A finished pass moves it to a second before the run started (capped by the
  oldest failure). A `changes` run reads each module from its cursor; `full` reads everything.
- **Fail loudly.** Every module's report has `failed` (zero included) and the run view `failedRecords`; the screen
  says "Finished with N failed". A scheduled run that _failed_, **or finished with records it could not write**
  (the cursor holds at them, so the next run meets them again), counts against the schedule: backoff by the streak
  and one mail per admin at the third (`bigin_sync_failing`, the #185 mail with the source named). Only a clean run
  ends a streak.

## Deletions (not mirrored)

After each module, `/<Module>/deleted?type=all` since the module's deletion cursor: every mapped record Bigin
deleted gets `missing_since` on its link — counted as `missingInSource` and listed under "Deleted in Bigin"
(`GET missing`) — and is never deleted here. A record seen again clears its flag.

## Data model (migrations `20261021090000_bigin_import`, `20261021100000_bigin_contact_reuse`)

`bigin_import_settings` (URLs, client id, sealed client secret and refresh token, last four of the token, sync
interval/failures/last error/cutover, saved accounts role, module cursors), `bigin_import_runs`,
`bigin_import_links` (+ `snapshot`), `bigin_contact_reuses`. All RLS `workspace_isolation`, `FORCE`, app grants;
`DELETE` only on settings.

## API (`/api/w/:id/import/bigin`, all `workspace:admin`)

`GET` · `PUT/DELETE settings` (secret and token write-only; an update may omit them to keep them) · `POST preview` ·
`POST runs` (`{ mode: full | changes, createMembers? }`) · `GET runs` · `GET runs/:id` · `POST runs/:id/cancel` ·
`GET missing` · `GET reuses` · `PUT sync` · `POST sync/cutover`.

## Switching it on

1. In Zoho's API console create a self client; grant a code for `ZohoBigin.modules.ALL,ZohoBigin.settings.READ` and
   exchange it for a refresh token.
2. Settings → Import from Bigin: data centre, client id, secret, refresh token → _Check connection_.
3. Run _Everything_ once (it merges into what the Twenty import brought), review the report, then set the
   automatic sync (hourly).
4. Retire the `twenty-bigin-sync` job (Bigin → Twenty), so Twenty stops receiving Bigin edits that would come back
   through the Twenty importer as conflicts; keep the Twenty importer for Twenty-native data until its cutover.
