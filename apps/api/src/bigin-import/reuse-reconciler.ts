import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { plainBiginId, type DomainEvent, type RecordTarget } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { chunked } from '../records/bulk/bulk.service';
import { companyDomain } from '../records/company-domain';
import { NotesService } from '../records/notes.service';
import { OpportunitiesService } from '../records/opportunities.service';
import { PeopleService } from '../records/people.service';
import { stored } from '../records/references';
import { TasksService } from '../records/tasks.service';
import { markdownToRichText } from '../twenty-import/markdown';
import { readConnection } from '../twenty-import/twenty-import.settings';
import { isObject, text } from '../twenty-import/twenty-records';
import { TwentyApiError, TwentyHttp } from '../twenty-import/twenty.http';
import type { TwentyApi, TwentyConnection, TwentyRecord } from '../twenty-import/twenty.port';
import { readBiginConnection } from './bigin-import.settings';
import { BIGIN_PORT, type BiginApi, type BiginConnection } from './bigin.port';
import { advanceWindow, biginInstant, startPass } from './cursor-policy';
import { identityHistory, type Identity, type Observation, type Segment, type TwentyChange } from './reuse-history';

/** A row of the old Bigin → Twenty job's logs: who a Contact held at an instant. */
export interface ReuseLogRow {
    biginId: string;
    ts: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
}

export const RECONCILED_SOURCE = 'Bigin (reused contact)';

export interface ReconcileSplit {
    identity: Identity;
    personId: string;
    how: 'created' | 'matched';
    until: string;
    moved: { notes: number; tasks: number; deals: number };
}

export interface ReconcileContact {
    biginId: string;
    holderId: string;
    before: Identity;
    after: Identity;
    splits: ReconcileSplit[];
}

export interface ReconcileReport {
    applied: boolean;
    contacts: ReconcileContact[];
    totals: {
        contactsSplit: number;
        peopleCreated: number;
        peopleMatched: number;
        holdersUpdated: number;
        notesMoved: number;
        tasksMoved: number;
        dealsMoved: number;
        alreadyReconciled: number;
        review: number;
    };
    review: { biginId: string; holderId: string | null; reason: string }[];
}

class DryRun extends Error {}

/**
 * The historical reconcile of reused Bigin Contacts (FR-CRMS-26). Before the direct sync existed, the old
 * Bigin → Twenty job wrote a Contact edited into another person over the earlier one — often the new name with
 * the old address — and BylineCRM imported those mixed rows from Twenty. For each Bigin Contact with history
 * (Twenty's `person.updated` timeline, the old job's logs, Bigin's current record) it rebuilds who the Contact
 * held (`identityHistory`) and, where the sync's rule says it was reused, splits the holder: the earlier people
 * become people of their own (matched by address first), keep the notes, tasks and deals made while they were
 * the Contact, and get a note saying so; the holder becomes the latest identity; the split is recorded as a
 * reuse (`source = reconcile`). Every write goes through the record services, as the import, with its events —
 * so mail re-links by address on its own and the timeline and webhooks see it. A dry run does it all in a
 * transaction per Contact and rolls it back. Nothing is deleted; a Contact reconciled once is not again.
 */
@Injectable()
export class BiginReuseReconciler {
    private readonly twenty: TwentyApi = new TwentyHttp();

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        @Inject(BIGIN_PORT) private readonly bigin: BiginApi,
        private readonly events: DomainEvents,
        private readonly people: PeopleService,
        private readonly notes: NotesService,
        private readonly tasks: TasksService,
        private readonly opportunities: OpportunitiesService,
    ) {}

    reconcile(workspaceId: string, options: ReconcileOptions): Promise<ReconcileReport> {
        const context: WorkspaceRunContext = {
            workspaceId,
            capabilities: new Set(),
            actor: { kind: 'import', id: randomUUID() },
        };
        return this.context.run(context, () => this.run(context, options));
    }

    private async run(context: WorkspaceRunContext, options: ReconcileOptions): Promise<ReconcileReport> {
        const progress = options.progress ?? (() => undefined);
        const report: ReconcileReport = {
            applied: options.apply,
            contacts: [],
            totals: {
                contactsSplit: 0,
                peopleCreated: 0,
                peopleMatched: 0,
                holdersUpdated: 0,
                notesMoved: 0,
                tasksMoved: 0,
                dealsMoved: 0,
                alreadyReconciled: 0,
                review: 0,
            },
            review: [],
        };
        const connections = await this.rls.withWorkspace(async (tx) => ({
            twenty: options.twenty === false ? null : ((await readConnection(tx, this.secrets))?.connection ?? null),
            bigin: (await readBiginConnection(tx, this.secrets))?.connection ?? null,
        }));

        if (!connections.twenty) progress('Twenty not read: the logs and Bigin only');
        // (a) Twenty: who carries which Bigin id, and every person update that touched a name or the emails.
        const changes = new Map<string, TwentyChange[]>();
        const twentyPeople = new Map<string, string[]>();
        if (connections.twenty) {
            const byTwentyId = new Map<string, string>();
            for (const person of await this.readAll(connections.twenty, 'people', progress)) {
                const biginId = plainBiginId(person.biginrecordid);
                if (!biginId) continue;
                byTwentyId.set(person.id, biginId);
                push(twentyPeople, biginId, person.id);
            }
            // Only `person.updated` entries, filtered by Twenty: the whole timeline is millions of rows (#251).
            for (const activity of await this.readAll(connections.twenty, 'timelineActivities', progress, {
                name: 'person.updated',
            })) {
                if (text(activity.name) !== 'person.updated') continue;
                const personId =
                    text(activity.personId) ?? text(activity.targetPersonId) ?? text(activity.linkedRecordId);
                const biginId = personId ? byTwentyId.get(personId) : undefined;
                const change = biginId ? changeOf(activity) : null;
                if (biginId && change) push(changes, biginId, change);
            }
        }
        // (b) the old job's logs.
        const observations = new Map<string, Observation[]>();
        for (const row of options.logs) {
            const biginId = plainBiginId(row.biginId);
            const at = biginInstant(row.ts);
            if (!biginId || !at) continue;
            push(observations, biginId, {
                at,
                identity: {
                    first: row.firstName?.trim() ?? '',
                    last: row.lastName?.trim() ?? '',
                    email: row.email?.trim().toLowerCase() || null,
                },
            });
        }
        const candidates = [...new Set([...changes.keys(), ...observations.keys()])].sort();
        progress(`${candidates.length} Bigin contacts with history`);
        // (c) Bigin's current record, the latest identity.
        if (connections.bigin && candidates.length > 0) {
            const wanted = new Set(candidates);
            for (const record of await this.readBiginContacts(connections.bigin, progress)) {
                const biginId = plainBiginId(record.id);
                if (!biginId || !wanted.has(biginId)) continue;
                push(observations, biginId, {
                    at: new Date(),
                    identity: {
                        first: text(record.First_Name) ?? '',
                        last: text(record.Last_Name) ?? '',
                        email: text(record.Email)?.toLowerCase() ?? null,
                    },
                });
            }
        }

        const holders = await this.rls.withWorkspace((tx) => holdersOf(tx, candidates, twentyPeople));
        const done = new Set(
            (
                await this.rls.withWorkspace((tx) =>
                    inBatches(candidates, (ids) =>
                        tx.biginContactReuse.findMany({
                            where: { source: 'reconcile', biginId: { in: ids } },
                            select: { biginId: true },
                        }),
                    ),
                )
            ).map((r) => r.biginId),
        );
        let origins: Map<string, Date> | null = null;

        for (const [index, biginId] of candidates.entries()) {
            if (index > 0 && index % 100 === 0) progress(`… ${index}/${candidates.length} contacts reconciled`);
            const holderId = holders.get(biginId) ?? null;
            if (!holderId) {
                if ((changes.get(biginId) ?? []).length > 0) {
                    report.review.push({ biginId, holderId: null, reason: 'no person here holds this Bigin contact' });
                }
                continue;
            }
            if (done.has(biginId)) {
                report.totals.alreadyReconciled += 1;
                continue;
            }
            const holder = await this.rls.withWorkspace((tx) =>
                tx.person.findUniqueOrThrow({
                    where: { id: holderId },
                    select: { nameFirst: true, nameLast: true, emailPrimary: true },
                }),
            );
            const history = identityHistory({
                holder: { first: holder.nameFirst, last: holder.nameLast, email: holder.emailPrimary },
                changes: changes.get(biginId) ?? [],
                observations: observations.get(biginId) ?? [],
            });
            for (const reason of history.review) report.review.push({ biginId, holderId, reason });
            if (history.segments.length < 2) continue;
            origins ??= connections.twenty ? await this.twentyOrigins(connections.twenty, progress) : new Map();
            try {
                const contact = await this.split(context, biginId, holderId, history.segments, origins, options.apply);
                report.contacts.push(contact);
                report.totals.contactsSplit += 1;
                report.totals.holdersUpdated += 1;
                for (const split of contact.splits) {
                    if (split.how === 'created') report.totals.peopleCreated += 1;
                    else report.totals.peopleMatched += 1;
                    report.totals.notesMoved += split.moved.notes;
                    report.totals.tasksMoved += split.moved.tasks;
                    report.totals.dealsMoved += split.moved.deals;
                }
            } catch (error) {
                if (error instanceof Unsplittable) {
                    report.review.push({ biginId, holderId, reason: error.message });
                    continue;
                }
                throw error;
            }
        }
        report.totals.review = report.review.length;
        return report;
    }

    /** One Contact's split, in one transaction — rolled back on a dry run so the counts are exact. */
    private async split(
        context: WorkspaceRunContext,
        biginId: string,
        holderId: string,
        segments: Segment[],
        origins: Map<string, Date>,
        apply: boolean,
    ): Promise<ReconcileContact> {
        let result: ReconcileContact | null = null;
        try {
            await this.rls.withWorkspace(async (tx) => {
                result = await this.splitIn(tx, context, biginId, holderId, segments, origins);
                if (!apply) throw new DryRun();
            });
        } catch (error) {
            if (!(error instanceof DryRun)) throw error;
        }
        return result!;
    }

    private async splitIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        biginId: string,
        holderId: string,
        segments: Segment[],
        origins: Map<string, Date>,
    ): Promise<ReconcileContact> {
        const events: DomainEvent[] = [];
        const holder = await tx.person.findUniqueOrThrow({ where: { id: holderId } });
        const latest = segments[segments.length - 1]!.identity;
        const before: Identity = { first: holder.nameFirst, last: holder.nameLast, email: holder.emailPrimary };
        const earlier = segments.slice(0, -1);
        if (!latest.email) throw new Unsplittable('the latest identity has no address');
        const taken = await tx.person.findFirst({
            where: { emailPrimary: latest.email, id: { not: holderId } },
            select: { id: true },
        });
        if (taken) throw new Unsplittable(`${latest.email} belongs to another person here (${taken.id})`);
        for (const segment of earlier) {
            if (!segment.identity.email || segment.identity.email === latest.email) {
                throw new Unsplittable(`an earlier identity (${name(segment.identity)}) has no address of its own`);
            }
        }

        // The holder becomes who the Contact holds now; the earlier addresses are freed for their people.
        const emails = stored<{ primary: string | null; additional: string[] }>(holder.emails);
        const freed = new Set(earlier.map((s) => s.identity.email));
        const updated = await this.people.updateIn(tx, context, holderId, {
            nameFirst: latest.first,
            nameLast: latest.last,
            emails: {
                primary: latest.email,
                additional: emails.additional.filter((e) => e !== latest.email && !freed.has(e)),
            },
        });
        if (updated.event) events.push(updated.event);

        const notes = await tx.noteTarget.findMany({
            where: { targetType: 'person', targetId: holderId },
            select: { noteId: true, note: { select: { createdAt: true } } },
        });
        const tasks = await tx.taskTarget.findMany({
            where: { targetType: 'person', targetId: holderId },
            select: { taskId: true, task: { select: { createdAt: true } } },
        });
        const deals = await tx.opportunity.findMany({
            where: { pointOfContactId: holderId },
            select: { id: true, createdAt: true },
        });
        const origin = (type: string, id: string, created: Date) => origins.get(`${type}:${id}`) ?? created;

        const splits: ReconcileSplit[] = [];
        for (const [index, segment] of earlier.entries()) {
            const until = segments[index + 1]!.from!;
            const since = segment.from;
            const inWindow = (at: Date) => at < until && (since === null || at >= since);
            const identity = segment.identity;
            const match = await tx.person.findFirst({ where: { emailPrimary: identity.email } });
            let personId: string;
            let how: ReconcileSplit['how'];
            if (match) {
                if (match.deletedAt) events.push((await this.people.restoreIn(tx, context, match.id)).event);
                personId = match.id;
                how = 'matched';
            } else {
                const domain = companyDomain(identity.email!.split('@')[1] ?? '');
                const company = domain
                    ? await tx.company.findFirst({ where: { domain, deletedAt: null }, select: { id: true } })
                    : null;
                const created = await this.people.createIn(tx, context, {
                    nameFirst: identity.first,
                    nameLast: identity.last,
                    emails: { primary: identity.email, additional: [] },
                    ownerId: holder.ownerId,
                    companyId: company?.id ?? null,
                    source: RECONCILED_SOURCE,
                });
                events.push(created.event);
                personId = created.row.id;
                how = 'created';
            }
            const note = await this.notes.createIn(tx, context, {
                title: 'Split from a reused Bigin contact',
                body: markdownToRichText(
                    `Bigin contact ${biginId} held this person until ${until.toISOString().slice(0, 10)}, then was reused for ${name(segments[index + 1]!.identity)}. The notes, tasks and deals from before then were moved here from that record.`,
                ),
                targets: [{ type: 'person', id: personId }],
                authorId: null,
            });
            events.push(note.event);

            const moved = { notes: 0, tasks: 0, deals: 0 };
            const swap = (targets: { targetType: string; targetId: string }[]): RecordTarget[] =>
                targets.map((t) => ({
                    type: t.targetType as RecordTarget['type'],
                    id: t.targetType === 'person' && t.targetId === holderId ? personId : t.targetId,
                }));
            for (const n of notes) {
                if (!inWindow(origin('note', n.noteId, n.note.createdAt))) continue;
                const targets = await tx.noteTarget.findMany({ where: { noteId: n.noteId } });
                const result = await this.notes.updateIn(tx, context, n.noteId, { targets: swap(targets) });
                if (result.event) events.push(result.event);
                moved.notes += 1;
            }
            for (const t of tasks) {
                if (!inWindow(origin('task', t.taskId, t.task.createdAt))) continue;
                const targets = await tx.taskTarget.findMany({ where: { taskId: t.taskId } });
                const result = await this.tasks.updateIn(tx, context, t.taskId, { targets: swap(targets) });
                if (result.event) events.push(result.event);
                moved.tasks += 1;
            }
            for (const d of deals) {
                if (!inWindow(origin('opportunity', d.id, d.createdAt))) continue;
                const result = await this.opportunities.updateIn(tx, context, d.id, { pointOfContactId: personId });
                if (result.event) events.push(result.event);
                moved.deals += 1;
            }
            await tx.biginContactReuse.create({
                data: {
                    workspaceId: context.workspaceId,
                    biginId,
                    previousPersonId: personId,
                    newPersonId: holderId,
                    detectedAt: until,
                    before: snapshot(identity),
                    after: snapshot(segments[index + 1]!.identity),
                    source: 'reconcile',
                },
            });
            splits.push({ identity, personId, how, until: until.toISOString(), moved });
        }
        await this.events.recordAll(tx, events);
        return { biginId, holderId, before, after: latest, splits };
    }

    /** When the notes, tasks and deals the Twenty importer made were created in Twenty, by local `type:id`. */
    private async twentyOrigins(connection: TwentyConnection, progress: Progress): Promise<Map<string, Date>> {
        const out = new Map<string, Date>();
        const links = await this.rls.withWorkspace((tx) =>
            tx.twentyImportLink.findMany({
                where: { object: { in: ['notes', 'tasks', 'opportunities'] } },
                select: { object: true, externalId: true, localType: true, localId: true },
            }),
        );
        if (links.length === 0) return out;
        const byExternal = new Map(links.map((l) => [`${l.object}:${l.externalId}`, `${l.localType}:${l.localId}`]));
        for (const object of ['notes', 'tasks', 'opportunities']) {
            for (const record of await this.readAll(connection, object, progress)) {
                const local = byExternal.get(`${object}:${record.id}`);
                const at = biginInstant(record.createdAt);
                if (local && at) out.set(local, at);
            }
        }
        return out;
    }

    /** Every record of a Twenty object, page by page (in bulk, never one request per person). */
    private async readAll(
        connection: TwentyConnection,
        objects: string,
        progress: Progress,
        filter: { name?: string } = {},
    ): Promise<TwentyRecord[]> {
        const out: TwentyRecord[] = [];
        let cursor: string | null = null;
        let pages = 0;
        for (;;) {
            let page;
            try {
                page = await this.twenty.list(connection, objects, { cursor, depth: 0, ...filter });
            } catch (error) {
                // An object this Twenty workspace does not have (no tasks): nothing to read. A refused key is the run's.
                if (
                    error instanceof TwentyApiError &&
                    error.permanent &&
                    error.status !== 401 &&
                    error.status !== 403
                ) {
                    return out;
                }
                throw error;
            }
            for (const record of page.records) out.push(record);
            pages += 1;
            const last = !page.hasNextPage || page.records.length === 0 || !page.endCursor;
            if (last || pages % 50 === 0) {
                progress(
                    `Twenty ${objects}${filter.name ? ` (${filter.name})` : ''}: ${out.length}/${page.totalCount}`,
                );
            }
            if (last) return out;
            cursor = page.endCursor;
        }
    }

    /**
     * Every Bigin Contact, read as the importer reads a module (`advanceWindow`): by modification windows, and where a
     * bulk edit put more than 2,000 in one second, by v2's page tokens — which start at the oldest record, so only
     * what is in the window moves it, and a record read in an earlier window is kept once.
     */
    private async readBiginContacts(connection: BiginConnection, progress: Progress) {
        const out: Awaited<ReturnType<BiginApi['list']>>['records'] = [];
        const kept = new Set<string>();
        const cursor = startPass(null, null);
        let pages = 0;
        while (!cursor.done) {
            const page = await this.bigin.list(connection, 'Contacts', {
                since: cursor.since,
                page: cursor.page,
                pageToken: cursor.pageToken ?? null,
                byToken: cursor.byToken ?? false,
            });
            for (const r of page.records) {
                const id = String(r.id);
                if (kept.has(id)) continue;
                kept.add(id);
                out.push(r);
            }
            const since = cursor.since ? new Date(cursor.since) : null;
            const inWindow = since
                ? page.records.filter((r) => {
                      const at = biginInstant(r.Modified_Time);
                      return !at || at >= since;
                  })
                : page.records;
            let latest: Date | null = null;
            for (const r of inWindow) {
                const at = biginInstant(r.Modified_Time);
                if (at && (!latest || at > latest)) latest = at;
            }
            advanceWindow(cursor, {
                ids: inWindow.map((r) => String(r.id)),
                latest,
                moreRecords: page.moreRecords && page.records.length > 0,
                nextPageToken: page.nextPageToken ?? null,
            });
            pages += 1;
            if (cursor.done || pages % 20 === 0) progress(`Bigin Contacts: ${out.length}`);
        }
        return out;
    }
}

type Progress = (line: string) => void;

export interface ReconcileOptions {
    apply: boolean;
    logs: readonly ReuseLogRow[];
    /**
     * Whether Twenty's history is read (default). False when Twenty is gone — its data deleted after the cutover —
     * though its connection is still stored: the reconcile then stands on the old job's logs and Bigin's current
     * record, and what they cannot tell apart goes to review, as it would without either.
     */
    twenty?: boolean;
    /** A line per stage and every so many pages or contacts, so a long run shows it is moving. */
    progress?: Progress;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
}

/** A Contact the reconcile will not split, for the review list. */
class Unsplittable extends Error {}

function name(identity: Identity): string {
    return [identity.first, identity.last].filter((p) => p).join(' ') || '(no name)';
}

function snapshot(identity: Identity): Prisma.InputJsonValue {
    return { name: name(identity), email: identity.email };
}

/** A Twenty timeline entry's name and emails diff, or null when it touched neither. */
function changeOf(activity: TwentyRecord): TwentyChange | null {
    const at = biginInstant(activity.happensAt) ?? biginInstant(activity.createdAt);
    const properties = isObject(activity.properties) ? activity.properties : null;
    const diff = properties && isObject(properties.diff) ? properties.diff : null;
    if (!at || !diff) return null;
    const nameOf = (value: unknown) =>
        isObject(value) ? { first: text(value.firstName) ?? '', last: text(value.lastName) ?? '' } : null;
    const emailOf = (value: unknown) => (isObject(value) ? (text(value.primaryEmail)?.toLowerCase() ?? null) : null);
    const change: TwentyChange = { at };
    if (isObject(diff.name)) change.name = { before: nameOf(diff.name.before), after: nameOf(diff.name.after) };
    if (isObject(diff.emails)) {
        const before = emailOf(diff.emails.before);
        const after = emailOf(diff.emails.after);
        if (before !== after) change.email = { before, after };
    }
    return change.name || change.email ? change : null;
}

/** Who holds each Bigin Contact here: its Bigin link, else the person imported from the Twenty person carrying its id. */
async function holdersOf(
    tx: WorkspaceClient,
    biginIds: readonly string[],
    twentyPeople: Map<string, string[]>,
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (biginIds.length === 0) return out;
    for (const link of await inBatches(biginIds, (ids) =>
        tx.biginImportLink.findMany({
            where: { object: 'Contacts', externalId: { in: ids } },
            select: { externalId: true, localId: true },
        }),
    )) {
        out.set(link.externalId, link.localId);
    }
    const twentyIds = biginIds.filter((id) => !out.has(id)).flatMap((id) => twentyPeople.get(id) ?? []);
    if (twentyIds.length > 0) {
        const byTwenty = new Map<string, string>();
        for (const [biginId, ids] of twentyPeople) for (const id of ids) byTwenty.set(id, biginId);
        for (const link of await inBatches(twentyIds, (ids) =>
            tx.twentyImportLink.findMany({
                where: { object: 'people', externalId: { in: ids } },
                select: { externalId: true, localId: true },
            }),
        )) {
            const biginId = byTwenty.get(link.externalId);
            if (biginId && !out.has(biginId)) out.set(biginId, link.localId);
        }
    }
    const live = await inBatches([...out.values()], (ids) =>
        tx.person.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } }),
    );
    const alive = new Set(live.map((p) => p.id));
    for (const [biginId, id] of out) if (!alive.has(id)) out.delete(biginId);
    return out;
}

/** Postgres takes at most 32767 bind values a statement; a whole workspace's Contacts can name more. */
const IN_BATCH = 10_000;

/** `read` over `ids` in runs of {@link IN_BATCH}, results in order. */
export async function inBatches<T>(ids: readonly string[], read: (ids: string[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (const run of chunked(ids, IN_BATCH)) out.push(...(await read(run)));
    return out;
}

/** The report as the CLI prints it: per Contact before → after and what moved, the review list, and totals (zero included). */
export function printReconcileReport(report: ReconcileReport, out: (line: string) => void = console.log): void {
    const who = (i: { first: string; last: string; email: string | null }) =>
        `${[i.first, i.last].filter((p) => p).join(' ') || '(no name)'} <${i.email ?? 'no address'}>`;
    for (const contact of report.contacts) {
        out(`contact ${contact.biginId}: person ${contact.holderId} ${who(contact.before)} -> ${who(contact.after)}`);
        for (const split of contact.splits) {
            out(
                `  until ${split.until.slice(0, 10)}: ${who(split.identity)} -> person ${split.personId} (${split.how}); ` +
                    `moved notes ${split.moved.notes}, tasks ${split.moved.tasks}, deals ${split.moved.deals}`,
            );
        }
    }
    for (const item of report.review) {
        out(`review ${item.biginId}${item.holderId ? ` (person ${item.holderId})` : ''}: ${item.reason}`);
    }
    const t = report.totals;
    // Always the outcome, zero included.
    out(
        `${report.applied ? 'changed' : 'would change (dry run)'}: contacts split ${t.contactsSplit}, people created ` +
            `${t.peopleCreated}, people matched ${t.peopleMatched}, holders updated ${t.holdersUpdated}, notes moved ` +
            `${t.notesMoved}, tasks moved ${t.tasksMoved}, deals moved ${t.dealsMoved}; already reconciled ` +
            `${t.alreadyReconciled}; for review ${t.review}`,
    );
}
