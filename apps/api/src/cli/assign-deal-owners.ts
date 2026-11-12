import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DomainEvents } from '../events/domain-events.service';
import { guardrailSettings, ownerlessMembers } from '../guardrails/guardrail-settings';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { OpportunitiesService } from '../records/opportunities.service';
import { PeopleService } from '../records/people.service';
import { TransfersService } from '../transfers/transfers.service';
import { importJobContext, JOB_WRITE_CHUNK, quietWorkers } from './job-common';

const USAGE =
    'usage: node dist/cli/assign-deal-owners.js <workspace-slug> --estimate|--apply [--by-mail <days>] [--batch <n>]';

/** Deals read per statement (`--batch`): a page, never the whole table. */
export const DEFAULT_BATCH = 500;

/** The reason on the hand-over that gave an unowned deal the owner of its contact. */
export const TRANSFER_REASON_DEAL_OWNER_FILL = 'Deal ownership: the contact’s owner';

/** The reason when the deal's company is a member's: a deal with a company is its owner's (OWN-2). */
export const TRANSFER_REASON_DEAL_COMPANY_OWNER = 'Deal ownership: the company’s owner';

/** The reason when nobody owns the contact or the company and a member is in mail with the contact (`byMailDays`). */
export const TRANSFER_REASON_DEAL_IN_MAIL = 'Deal ownership: the member in mail with the contact';

export interface AssignDealsOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    /** Deals read per statement; `DEFAULT_BATCH` when absent. */
    batch?: number | undefined;
    /**
     * For a deal whose contact and company nobody active owns: give it — and its contact — to the member most
     * recently in mail with the contact (either way) within this many days. Absent: such a deal is left.
     */
    byMailDays?: number | undefined;
    onProgress?: (line: string) => void;
}

export interface AssignDealsReport {
    /** Open deals with no owner. */
    deals: number;
    /** Of those, given an owner: the three below. */
    assigned: number;
    /** Given to the active owner of the deal's company: a deal with a company is its owner's (OWN-2). */
    toCompanyOwner: number;
    /** Given to the active owner of their contact (the company is nobody's). */
    toContactOwner: number;
    /** `byMailDays`: given, with their contact, to the member in mail with the contact. */
    toMemberInMail: number;
    /** Left: nobody active owns the company or the contact, and (with `byMailDays`) no member is in mail with them. */
    nobodyToGive: number;
    /** The members given deals, and the most one of them was given. */
    owners: number;
    mostToOne: number;
    /** Deals left as they were: their chunk was refused (the reason is on stderr, no record named). */
    failed: number;
}

/**
 * The import left open deals with no owner: on nobody's pipeline, nobody's Dashboard. Each is given to the active
 * owner of its company (a deal with a company is its owner's, OWN-2), else to the active owner of its contact, else
 * — with `byMailDays` — to the member most recently in mail with the contact, who is given the contact too. As an
 * import fills an empty owner: the record service's write and a silent hand-over on the record's ownership history
 * (`recordHandOverIn`), `JOB_WRITE_CHUNK` per transaction, kept in BylineCRM (`internal`). A member who has left, or
 * a shared mailbox, is nobody (as to the guard). Re-running changes nothing once done. Counts only.
 */
export async function assignDealOwners(
    app: INestApplicationContext,
    workspaceId: string,
    options: AssignDealsOptions,
): Promise<AssignDealsReport> {
    const owner = app.get(PrismaService);
    const rls = app.get(RlsPrismaService);
    const scope = app.get(WorkspaceContext);
    const deals = app.get(OpportunitiesService);
    const people = app.get(PeopleService);
    const transfers = app.get(TransfersService);
    const events = app.get(DomainEvents);
    const context = importJobContext(workspaceId);
    const progress = options.onProgress ?? (() => undefined);
    const BATCH = options.batch ?? DEFAULT_BATCH;
    if (!Number.isInteger(BATCH) || BATCH < 1) throw new Error('batch must be a whole number of deals, 1 or more');
    const report: AssignDealsReport = {
        deals: 0,
        assigned: 0,
        toCompanyOwner: 0,
        toContactOwner: 0,
        toMemberInMail: 0,
        nobodyToGive: 0,
        owners: 0,
        mostToOne: 0,
        failed: 0,
    };
    const nobody = await rls.withWorkspace(workspaceId, async (tx) =>
        ownerlessMembers(tx, await guardrailSettings(tx)),
    );
    const active = (id: string | null) => (id !== null && !nobody.has(id) ? id : null);
    const given = new Map<string, number>();

    const byMailDays = options.byMailDays;
    if (byMailDays !== undefined && (!Number.isInteger(byMailDays) || byMailDays < 1)) {
        throw new Error('byMailDays must be a whole number of days, 1 or more');
    }
    type Why = 'toCompanyOwner' | 'toContactOwner' | 'toMemberInMail';
    interface Fill {
        id: string;
        to: string;
        why: Why;
        /** `toMemberInMail`: the contact, given to the same member. */
        contactId: string | null;
    }
    const REASON: Record<Why, string> = {
        toCompanyOwner: TRANSFER_REASON_DEAL_COMPANY_OWNER,
        toContactOwner: TRANSFER_REASON_DEAL_OWNER_FILL,
        toMemberInMail: TRANSFER_REASON_DEAL_IN_MAIL,
    };

    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
        const page = await owner.$queryRaw<
            { id: string; contact_id: string | null; contact_owner: string | null; company_owner: string | null }[]
        >`
            SELECT d.id::text AS id, p.id::text AS contact_id, p.owner_id::text AS contact_owner,
                   c.owner_id::text AS company_owner
            FROM opportunities d
            JOIN pipeline_stages s ON s.id = d.stage_id AND s.kind = 'open'
            LEFT JOIN people p ON p.id = d.point_of_contact_id AND p.deleted_at IS NULL
            LEFT JOIN companies c ON c.id = d.company_id AND c.deleted_at IS NULL
            WHERE d.workspace_id = ${workspaceId}::uuid AND d.deleted_at IS NULL AND d.closed_at IS NULL
              AND d.owner_id IS NULL AND d.id > ${after}::uuid
            ORDER BY d.id LIMIT ${BATCH}`;
        if (page.length === 0) break;
        report.deals += page.length;
        const fills: Fill[] = [];
        const loose: { id: string; contactId: string }[] = [];
        for (const d of page) {
            const companyOwner = active(d.company_owner);
            const contactOwner = active(d.contact_owner);
            if (companyOwner) fills.push({ id: d.id, to: companyOwner, why: 'toCompanyOwner', contactId: null });
            else if (contactOwner) fills.push({ id: d.id, to: contactOwner, why: 'toContactOwner', contactId: null });
            else if (byMailDays !== undefined && d.contact_id) loose.push({ id: d.id, contactId: d.contact_id });
            else report.nobodyToGive += 1;
        }
        if (loose.length > 0) {
            // The member on the newest message with each contact, either way; a member who is nobody is not one.
            const inMail = await owner.$queryRaw<{ person_id: string; member_id: string }[]>`
                SELECT DISTINCT ON (mp.person_id) mp.person_id::text AS person_id, sp.member_id::text AS member_id
                FROM mail_participants mp
                JOIN mail_messages mm ON mm.id = mp.message_id
                 AND mm.sent_at >= now() - make_interval(days => ${byMailDays!}::int)
                JOIN mail_participants sp ON sp.message_id = mm.id AND sp.member_id IS NOT NULL
                 AND sp.member_id::text <> ALL (${[...nobody]}::text[])
                WHERE mp.workspace_id = ${workspaceId}::uuid
                  AND mp.person_id::text = ANY (${loose.map((l) => l.contactId)}::text[])
                ORDER BY mp.person_id, mm.sent_at DESC`;
            const memberOf = new Map(inMail.map((r) => [r.person_id, r.member_id]));
            for (const l of loose) {
                const to = memberOf.get(l.contactId);
                if (to) fills.push({ id: l.id, to, why: 'toMemberInMail', contactId: l.contactId });
                else report.nobodyToGive += 1;
            }
        }
        for (let at = 0; at < fills.length; at += JOB_WRITE_CHUNK) {
            const chunk = fills.slice(at, at + JOB_WRITE_CHUNK);
            let done: Fill[] = chunk;
            if (options.apply) {
                try {
                    done = await scope.run(context, () =>
                        rls.withWorkspace(workspaceId, async (tx) => {
                            const filled: Fill[] = [];
                            for (const f of chunk) {
                                // A deal given an owner, closed or removed since the read is left as it is.
                                const still = await tx.opportunity.findFirst({
                                    where: { id: f.id, ownerId: null, deletedAt: null, closedAt: null },
                                    select: { id: true },
                                });
                                if (!still) continue;
                                if (f.contactId) {
                                    // The contact first, while nobody active owns them still: theirs, as the deal is.
                                    const contact = await tx.person.findFirst({
                                        where: { id: f.contactId, deletedAt: null },
                                        select: { ownerId: true },
                                    });
                                    if (!contact || active(contact.ownerId)) continue;
                                    const moved = await people.updateIn(tx, context, f.contactId, { ownerId: f.to });
                                    if (moved.event) await events.record(tx, { ...moved.event, internal: true });
                                    await transfers.recordHandOverIn(tx, context, {
                                        from: null,
                                        to: f.to,
                                        target: { type: 'person', id: f.contactId },
                                        reason: REASON[f.why],
                                        silent: true,
                                    });
                                }
                                const updated = await deals.updateIn(tx, context, f.id, { ownerId: f.to });
                                if (updated.event) await events.record(tx, { ...updated.event, internal: true });
                                for (const e of updated.taskEvents) await events.record(tx, { ...e, internal: true });
                                await transfers.recordHandOverIn(tx, context, {
                                    from: null,
                                    to: f.to,
                                    target: { type: 'opportunity', id: f.id },
                                    reason: REASON[f.why],
                                    silent: true,
                                });
                                filled.push(f);
                            }
                            return filled;
                        }),
                    );
                } catch (error) {
                    report.failed += chunk.length;
                    progress(`refused: ${error instanceof Error ? error.message : String(error)}`);
                    done = [];
                }
            }
            report.assigned += done.length;
            for (const f of done) {
                report[f.why] += 1;
                given.set(f.to, (given.get(f.to) ?? 0) + 1);
            }
        }
        after = page[page.length - 1]!.id;
        progress(`… ${report.deals} open deals without an owner, ${report.assigned} given an owner`);
    }
    report.owners = given.size;
    report.mostToOne = Math.max(0, ...given.values());
    return report;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const flags = args.slice(1);
    let byMailDays: number | undefined;
    const mail = flags.indexOf('--by-mail');
    if (mail >= 0) {
        byMailDays = Number(flags[mail + 1]);
        if (!Number.isInteger(byMailDays) || byMailDays < 1) throw new Error(USAGE);
        flags.splice(mail, 2);
    }
    let batch: number | undefined;
    const at = flags.indexOf('--batch');
    if (at >= 0) {
        batch = Number(flags[at + 1]);
        if (!Number.isInteger(batch) || batch < 1) throw new Error(USAGE);
        flags.splice(at, 2);
    }
    const known = new Set(['--estimate', '--apply']);
    const apply = flags.includes('--apply');
    if (!slug || slug.startsWith('--') || flags.some((f) => !known.has(f)) || apply === flags.includes('--estimate')) {
        throw new Error(USAGE);
    }
    quietWorkers();
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const workspace = await app.get(PrismaService).workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const report = await assignDealOwners(app, workspace.id, {
            apply,
            batch,
            byMailDays,
            onProgress: (line) => console.error(line),
        });
        const would = apply ? '' : 'would be ';
        console.log(`${report.deals} open deals without an owner`);
        console.log(
            `${would}given an owner: ${report.assigned}, among ${report.owners} members (at most ${report.mostToOne} to one)`,
        );
        console.log(
            `  the company’s owner: ${report.toCompanyOwner}; the contact’s owner: ${report.toContactOwner}; the member in mail with the contact: ${report.toMemberInMail}`,
        );
        console.log(`left, nobody to give them to: ${report.nobodyToGive}`);
        if (apply) console.log(`refused and left as they were: ${report.failed}`);
        else console.log('estimate: nothing changed; add --apply to do it');
    } finally {
        await app.close();
    }
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
