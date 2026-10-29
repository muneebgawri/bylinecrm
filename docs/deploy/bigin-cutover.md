# Bigin → BylineCRM cutover — runbook (BIGIN-1)

**What it is.** The Pinion Newswire workspace stops treating Zoho Bigin as a source: the last Bigin edits are pulled
in, the hourly sync is stopped (Settings → Import → Bigin → **Stop syncing (cutover)**, `POST
/api/w/:ws/import/bigin/sync/cutover`, which records `bigin_import_settings.cutover_at`), the team works only in
BylineCRM, and Bigin is made read-only, then retired. The sync is one way (Bigin → BylineCRM) and never deletes, so
nothing in BylineCRM is lost by stopping it — the risk is edits made in Bigin **after** the final sync, which no step
brings back. Everything below is ordered around that.

Who: **Owner** (Matt) decides go/no-go and sends comms; **Operator** (whoever runs the commands — prod deploys and
writes are run from the Mac with the repo checked out, see `docs/deploy/production.md`). Times are UTC.

---

## Gates — all must be true before T-0 (go/no-go at T-1)

| #   | Gate                       | How to check                                                                                                                                                                                                                                            | State 2026-10-29                                                       |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| G1  | Opt-outs carried           | Bigin `Email_Opt_Out` contacts are suppressed (`bigin-suppress-opt-outs <slug>` dry run says `would suppress 0`)                                                                                                                                        | **Met** (258 addresses, #292)                                          |
| G2  | Notes fix live             | `main` contains d1b6571 / #291                                                                                                                                                                                                                          | **Met**                                                                |
| G3  | Missing data imported      | the "missing data" PR (phones, descriptions, press-release title, tasks/meetings/calls) deployed **and** one run with _What to read_: **Everything** since, succeeded, `failed` 0 per module (a full run read ~11 h last time: start it in the evening) | Open                                                                   |
| G4  | Reused contacts reconciled | FR-CRMS-26 run from the old job's logs (#293, `--no-twenty`), review list read, `--apply` done                                                                                                                                                          | Open                                                                   |
| G5  | Sync healthy               | last 24 h of `changes` runs all `succeeded`; `bigin_import_settings.sync_failures = 0`                                                                                                                                                                  | Met (daily check)                                                      |
| G6  | Team works in BylineCRM    | for 5 working days: deals moved and created by members in BylineCRM (not rules/imports); every AM has signed in                                                                                                                                         | **Not met** (0 member stage moves in 7 d; 9 employees never signed in) |
| G7  | Backups                    | last nightly `bylinecrm-backup@production` succeeded; a restore drill done this month                                                                                                                                                                   | Check                                                                  |
| G8  | Bigin export               | a full Bigin data backup exported and stored (Bigin → Settings → Data Administration → Export/Backup), for the record and as the rollback source                                                                                                        | Open                                                                   |

Queries for G5/G6 (read-only, on the server):

```sh
ssh newswireos-vps 'docker exec -i bylinecrm-production-postgres-1 sh -c "psql -X -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\""' <<'SQL'
BEGIN READ ONLY;
SELECT status, count(*) FROM bigin_import_runs WHERE queued_at > now() - interval '24 hours' GROUP BY 1;
SELECT sync_interval, sync_failures, sync_last_error, cutover_at FROM bigin_import_settings;
SELECT actor->>'kind' AS by, count(*) FROM opportunity_stage_history WHERE entered_at > now() - interval '7 days' GROUP BY 1;
SELECT created_by->>'kind' AS by, count(*) FROM opportunities WHERE created_at > now() - interval '7 days' GROUP BY 1;
ROLLBACK;
SQL
```

---

## T-7 days — prepare

1. **Owner:** pick T-0 — a weekday, after the morning, never during a NewswireOS release (a NewswireOS deploy holds
   `/opt/newswireos-runtime/deploy.lock`, and a CRM deploy that meets it reverts — retry when it clears).
2. **Owner → team (comms 1):** the date, the reason, "from T-0 you work only in BylineCRM; Bigin becomes read-only",
   where to get help, and that edits made in Bigin after T-0 are **not** carried over.
3. **Operator:** close G3 and G4 (see their PRs' owner steps). Capture the **baseline counts** (below) into the
   cutover log.
4. **Owner:** onboarding for whoever has not signed in (G6); ask AMs to move their deals in BylineCRM from now on.

## T-1 day — go/no-go

1. **Operator:** re-check every gate; record the results in the cutover log.
2. **Operator:** take a backup by hand and read it: `ssh newswireos-vps 'bash /opt/bylinecrm/tools/production/backup.sh production'`
   (the tooling the nightly timer runs, `production.md` § Backups); note the stamp it prints.
3. **Owner:** go / no-go. No-go if any gate is open — move T-0.
4. **Owner → team (comms 2):** "Tomorrow at HH:MM Bigin becomes read-only. Finish anything open in Bigin today, or do
   it in BylineCRM."

## T-0 — cutover (about 1 hour)

1. **HH:00 — freeze Bigin (Owner, in Bigin).** Make every user except the Owner read-only: Bigin → Settings → Users
   & Control → Profiles → give the sales profile read-only permissions on Contacts, Companies, Pipelines/Deals, Notes,
   Tasks (or deactivate the users if read access is not needed). Record the instant: this is the **freeze time**.
   From here no Bigin edit can be lost, because none can be made.
2. **HH:05 — final sync (Operator).** Settings → Import → Bigin → _What to read_: **Changes since the cursor** →
   **Start sync**, and wait for it to succeed. Then a second `changes` run: it must report 0 created / 0 updated (nothing moved since the freeze). If
   `failed` > 0 in either, stop and read the run report before going on.
3. **HH:15 — count check (Operator).** Compare Bigin's own totals (each module's list view, "All …" with the record
   count; or the export from G8) with BylineCRM's links:

    ```sql
    SELECT object, count(*) AS linked, count(*) FILTER (WHERE missing_since IS NOT NULL) AS deleted_in_bigin
    FROM bigin_import_links GROUP BY 1 ORDER BY 1;
    ```

    Per module `linked + skipped (see the last Everything run's report) ≈ Bigin's total`. A gap larger than the
    skipped rows (no name, no email, no content) is a no-go: find the records (`/import/bigin/missing`, run reports)
    before going on.

4. **HH:25 — spot check (Owner).** Open 5 recent deals, 5 contacts and 5 companies in both systems: stage, owner,
   amount, company, phone, notes, tasks agree.
5. **HH:35 — stop the sync (Operator).** Settings → Import → Bigin → **Stop syncing (cutover)**. Check
   `bigin_import_settings.sync_interval = 'off'` and `cutover_at` is set; the next hour shows no new `changes` run.
6. **HH:40 — comms 3 (Owner → team):** "Cutover done. Work only in BylineCRM. Bigin is read-only and will be retired
   on <date>."
7. **Operator:** write the cutover log (below) into the issue/PR that tracks the cutover.

## T+1 … T+14 — after

- **Daily for a week (Operator):** the G6 query — members are moving and creating deals in BylineCRM; nobody asks for
  Bigin edits. Bigin's "last modified" stays at the freeze time.
- **T+7 (Operator):** revoke the Zoho self-client grant (Zoho API console → the self client → delete), so nothing
  can read Bigin with the stored token; then remove the connection in Settings → Import → Bigin.
- **T+14 (Owner):** retire Bigin — downgrade or cancel the subscription after confirming the G8 export is stored.
  Keep the export for the retention period the business requires.
- **Docs:** mark BIGIN-1.md's cutover done with the date; update `docs/fr-scope.txt` only if a requirement changes.

## Rollback

Before step 5 (sync still on): abort = unfreeze Bigin (undo step 1). Nothing else changed.

After step 5, within T+7 (the Zoho grant still exists):

1. Re-open Bigin for editing (undo step 1).
2. Settings → Import → Bigin → set the sync back to hourly (the stored connection and cursors still work; the run
   picks up from the last cursor, and BylineCRM edits keep winning per field as before).
3. Comms: "Back to Bigin until <new date>."

Nothing written to BylineCRM is ever undone by a rollback (the sync is one way and never deletes); BylineCRM work done
after the cutover stays. After the Zoho grant is revoked, rolling back means a new self client and grant (BIGIN-1
"Switching it on").

---

## Cutover log (fill in)

| Item                                                                     | Value |
| ------------------------------------------------------------------------ | ----- |
| Freeze time (UTC)                                                        |       |
| Final `changes` runs (ids, created/updated/failed)                       |       |
| Baseline counts at T-7 and at T-0 (Bigin / linked / skipped, per module) |       |
| Spot check result                                                        |       |
| `cutover_at`                                                             |       |
| Backup stamp taken at T-1                                                |       |
| Bigin export stored at                                                   |       |
| Zoho grant revoked (date)                                                |       |
| Bigin retired (date)                                                     |       |
