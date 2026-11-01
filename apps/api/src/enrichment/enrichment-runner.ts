import { Inject, Injectable, Logger } from '@nestjs/common';
import {
    ENRICHMENT_FACTS,
    isBetterAnswer,
    isPlaceholderCompanyName,
    type Emails,
    type EnrichmentFactKey,
    type EnrichmentObject,
    type EnrichmentSource,
    type Links,
} from '@bylinecrm/shared';
import type { EnrichmentAnswer, Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { mapPool } from '../infra/map-pool';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { CompaniesService, type CompanyInput } from '../records/companies.service';
import { PeopleService, type PersonInput } from '../records/people.service';
import { ENRICHMENT_PEOPLE_SAMPLE, ENRICHMENT_SOURCE_CONCURRENCY } from './enrichment.constants';
import { EnrichmentSettingsService } from './enrichment-settings.service';
import { ENRICHERS, type Enricher, type EnrichmentFinding, type EnrichmentSubject } from './enricher.port';

/** What one run did: the sources it asked, the answers it kept, the fields it wrote. */
export interface EnrichmentRunReport {
    asked: EnrichmentSource[];
    answers: number;
    applied: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Enriches one record (P4-2, FR-CRMS-15), as the job does, in three steps and never with the network
 * inside a transaction: (1) read the record, the workspace's settings and when each source was last
 * asked; (2) ask every source that is on, applies, and is due — older than the re-ask age, or
 * `force` — with no transaction open; (3) in one transaction keep every answer with its source and
 * time, and write to the record each answered fact that maps to a field and is better than what is
 * there (`isBetterAnswer`: the rule per type, with "what enrichment wrote" read from the last answer
 * that was applied), through the one update path (`updateIn`), which records the `updated` event.
 * No answer is kept as no answer; a source that fails is kept as failed for each of its facts.
 */
@Injectable()
export class EnrichmentRunner {
    private readonly logger = new Logger(EnrichmentRunner.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly settings: EnrichmentSettingsService,
        private readonly companies: CompaniesService,
        private readonly people: PeopleService,
        @Inject(ENRICHERS) private readonly enrichers: Enricher[],
    ) {}

    enrich(
        workspaceId: string,
        object: EnrichmentObject,
        recordId: string,
        options: { force: boolean; now?: Date },
    ): Promise<EnrichmentRunReport> {
        const context: WorkspaceRunContext = {
            workspaceId,
            capabilities: new Set(['record:read', 'record:write']),
            actor: { kind: 'system', id: null },
        };
        return this.context.run(context, () => this.run(context, object, recordId, options));
    }

    private async run(
        context: WorkspaceRunContext,
        object: EnrichmentObject,
        recordId: string,
        options: { force: boolean; now?: Date },
    ): Promise<EnrichmentRunReport> {
        const now = options.now ?? new Date();
        const loaded = await this.rls.withWorkspace(async (tx) => {
            const subject = await this.subject(tx, context.workspaceId, object, recordId);
            if (!subject) return null;
            const settings = await this.settings.settingsIn(tx);
            const lastAsked = await tx.enrichmentAnswer.groupBy({
                by: ['source'],
                where: { object, recordId },
                _max: { askedAt: true },
            });
            return { subject, settings, lastAsked: new Map(lastAsked.map((r) => [r.source, r._max.askedAt])) };
        });
        if (!loaded) {
            this.logger.warn(`${object} ${recordId}: not found or deleted; nothing asked`);
            return { asked: [], answers: 0, applied: 0 };
        }
        const { subject, settings, lastAsked } = loaded;
        const dueNow = this.enrichers.filter((e) => {
            if (!settings.sources[e.source] || !e.applies(subject)) return false;
            const last = lastAsked.get(e.source);
            return options.force || !last || now.getTime() - last.getTime() > settings.reaskAfterDays * DAY_MS;
        });
        // A source linked per workspace (BylineAI) is not asked where the workspace has not linked it.
        const linked = await Promise.all(
            dueNow.map((e) => (e.available ? e.available(context.workspaceId) : Promise.resolve(true))),
        );
        const due = dueNow.filter((_, i) => linked[i]);
        if (due.length === 0) return { asked: [], answers: 0, applied: 0 };

        // No transaction is open here: the sources reach the network.
        const findings = await mapPool(due, ENRICHMENT_SOURCE_CONCURRENCY, async (enricher) => ({
            source: enricher.source,
            findings: await this.ask(enricher, subject),
        }));
        const askedAt = new Date();

        const applied = await this.rls.withWorkspace(async (tx) => {
            const rows: EnrichmentAnswer[] = [];
            for (const { source, findings: list } of findings) {
                for (const f of list) {
                    rows.push(
                        await tx.enrichmentAnswer.create({
                            data: {
                                workspaceId: context.workspaceId,
                                object,
                                recordId,
                                field: f.field,
                                source,
                                status: f.status,
                                value: f.status === 'answered' ? f.value : null,
                                rank: f.status === 'answered' ? f.rank : 0,
                                note: f.note ?? null,
                                askedAt,
                            },
                        }),
                    );
                }
            }
            return this.apply(tx, context, object, recordId, rows);
        });
        return {
            asked: due.map((e) => e.source),
            answers: findings.reduce((n, f) => n + f.findings.length, 0),
            applied,
        };
    }

    /** A source's findings, or — when it throws — a failure for each fact it answers for the object. */
    private async ask(enricher: Enricher, subject: EnrichmentSubject): Promise<EnrichmentFinding[]> {
        try {
            return await enricher.enrich(subject);
        } catch (error) {
            const note = error instanceof Error ? error.message : String(error);
            this.logger.warn(`${enricher.source} failed for ${subject.object} ${subject.id}: ${note}`);
            return enricher.facts(subject.object).map((field) => ({ field, status: 'failed', note }));
        }
    }

    /** What the sources may read about the record; `null` when it is gone or not in scope. */
    private async subject(
        tx: WorkspaceClient,
        workspaceId: string,
        object: EnrichmentObject,
        id: string,
    ): Promise<EnrichmentSubject | null> {
        if (object === 'company') {
            const row = await tx.company.findFirst({
                where: { id, deletedAt: null },
                select: {
                    name: true,
                    domain: true,
                    logoUrl: true,
                    links: true,
                    people: { where: { deletedAt: null }, select: { emails: true }, take: ENRICHMENT_PEOPLE_SAMPLE },
                },
            });
            if (!row) return null;
            return {
                workspaceId,
                object,
                id,
                company: {
                    name: row.name,
                    domain: row.domain,
                    logoUrl: row.logoUrl,
                    links: row.links as Links,
                    peopleEmails: row.people.flatMap((p) => {
                        const primary = (p.emails as Emails | null)?.primary;
                        return primary ? [primary] : [];
                    }),
                },
            };
        }
        const row = await tx.person.findFirst({
            where: { id, deletedAt: null },
            select: { emails: true, country: true, ownerId: true },
        });
        if (!row) return null;
        return {
            workspaceId,
            object,
            id,
            person: {
                email: (row.emails as Emails | null)?.primary ?? null,
                country: row.country,
                ownerId: row.ownerId,
            },
        };
    }

    /**
     * Writes the answered facts that are better than what the record holds, in one update through
     * the record's own service, and marks those answers applied. "What enrichment wrote" for a field
     * is the last applied answer whose value is still the field's value; any other value is a
     * member's or an import's and is never replaced.
     */
    private async apply(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        object: EnrichmentObject,
        recordId: string,
        answers: EnrichmentAnswer[],
    ): Promise<number> {
        const candidates = answers.filter(
            (a): a is EnrichmentAnswer & { value: string } =>
                a.status === 'answered' &&
                a.value !== null &&
                ENRICHMENT_FACTS[a.field as EnrichmentFactKey]?.applies !== null,
        );
        if (candidates.length === 0) return 0;
        const current = object === 'company' ? await this.companies.get(recordId) : await this.people.get(recordId);
        const previous = await tx.enrichmentAnswer.findMany({
            where: { object, recordId, applied: true, field: { in: candidates.map((c) => c.field) } },
            orderBy: { askedAt: 'desc' },
            select: { field: true, value: true, rank: true },
        });
        const wrote = new Map<string, { value: string | null; rank: number }>();
        for (const p of previous) if (!wrote.has(p.field)) wrote.set(p.field, { value: p.value, rank: p.rank });

        const chosen = new Map<EnrichmentFactKey, EnrichmentAnswer & { value: string }>();
        for (const answer of candidates) {
            const field = answer.field as EnrichmentFactKey;
            const fact = ENRICHMENT_FACTS[field];
            const stored = fieldValue(current as Record<string, unknown>, fact.applies!);
            // A company named by its domain, or not at all, has a placeholder, not a name (#170): the
            // website's name fills it as it would an empty field. A name that is itself a bare host
            // is no better than the placeholder.
            const placeholder =
                field === 'name' && isPlaceholderCompanyName(stored, (current as { domain?: string | null }).domain);
            if (field === 'name' && isPlaceholderCompanyName(answer.value, null)) continue;
            const value = placeholder ? null : stored;
            const last = wrote.get(field);
            const rank = last && last.value === value ? last.rank : null;
            const already = chosen.get(field);
            const against = already ? { value: already.value, rank: already.rank } : { value, rank };
            if (isBetterAnswer(fact.type, { value: answer.value, rank: answer.rank }, against))
                chosen.set(field, answer);
        }
        if (chosen.size === 0) return 0;

        const patch: Record<string, unknown> = {};
        for (const [field, answer] of chosen) {
            setField(patch, current as Record<string, unknown>, ENRICHMENT_FACTS[field].applies!, answer.value);
        }
        const result =
            object === 'company'
                ? await this.companies.updateIn(tx, context, recordId, patch as CompanyInput)
                : await this.people.updateIn(tx, context, recordId, patch as PersonInput);
        if (result.event) await this.events.record(tx, result.event);
        await tx.enrichmentAnswer.updateMany({
            where: { id: { in: [...chosen.values()].map((a) => a.id) } },
            data: { applied: true },
        });
        return chosen.size;
    }
}

/** The record field a fact maps to, as a string: `links.linkedin` is the link's URL. */
function fieldValue(record: Record<string, unknown>, applies: string): string | null {
    if (applies.startsWith('links.')) {
        const link = (record.links as Links)[applies.slice('links.'.length) as keyof Links];
        return link?.url ?? null;
    }
    const value = record[applies];
    return typeof value === 'string' ? value : null;
}

function setField(
    patch: Record<string, unknown>,
    record: Record<string, unknown>,
    applies: string,
    value: string,
): void {
    if (applies.startsWith('links.')) {
        const links = (patch.links as Links | undefined) ?? { ...(record.links as Links) };
        links[applies.slice('links.'.length) as keyof Links] = { url: value, label: null };
        patch.links = links;
        return;
    }
    patch[applies] = value;
}

export type { Prisma };
