import { Injectable } from '@nestjs/common';
import { TWENTY_IMPORT_SOURCE, type Money, type RecordTarget, type TimelineActor } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { normalisedDomain } from '../records/company-ownership';
import {
    NEWSWIREOS_CLIENT_NOTE,
    NEWSWIREOS_CLIENT_SOURCE,
    NEWSWIREOS_TIMELINE_EVENTS,
    NEWSWIREOS_TIMELINE_SOURCE,
    type NewswireosTimelineEventType,
} from './invoices.constants';

/** The client a NewswireOS event names (doc 11 §8s), lower-cased; matched on its ids, then email, then domain. */
export interface TimelineClient {
    customerId: string | null;
    email: string | null;
    name: string | null;
    companyDomain: string | null;
    bylineContactId: string | null;
    bylineCompanyId: string | null;
}

/** One timeline delivery, read defensively. */
export interface TimelineDelivery {
    id: string;
    type: NewswireosTimelineEventType;
    occurredAt: Date | null;
    title: string;
    url: string | null;
    amount: Money | null;
    /** Null for an agency's invoice: kept, unmatched. */
    client: TimelineClient | null;
    /** `am.assigned`'s `data.account_manager.name`; null when it carries none. */
    accountManager: string | null;
    payload: unknown;
}

type MatchedBy = 'byline_contact_id' | 'byline_company_id' | 'email' | 'domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PNW-766 (doc 11 §8s, FR-CRM-6c): NewswireOS's client activity on the timeline. Five events arrive on the payment
 * hook, signed with its secret: `client.created`, `order.paid`, `invoice.paid`, `distribution.completed` and
 * `am.assigned`.
 *
 * - **Stored first, matched or not.** Every delivery is a `newswireos_timeline_events` row keyed on its id
 *   (`x-webhook-id`): a redelivery is `duplicate` and writes nothing. NewswireOS gets its 2xx either way.
 * - **Matched** on the client's `byline_contact_id`, then `byline_company_id`, then the email (a person's primary),
 *   then the company domain (a company's own or other domain), and put on that one record's timeline as an
 *   `external.newswireos_<event>` entry, source `newswireos`, keyed on the delivery. A company's timeline shows its
 *   people's, so a person's entry is not also written on the company.
 * - **The timeline only.** `invoice.paid` verifies nothing and moves no stage: that stays the lookup's (§8q).
 * - **Exclusions.** `client.created` and `am.assigned` keep the client's `account_managed` exclusion as the client
 *   sync does (`sync-newswireos-clients`): one this source made is renamed to the new account manager; a Twenty lead
 *   lookup's becomes this source's; any other (by hand, a won deal, a domain) already keeps them out and is left.
 */
@Injectable()
export class NewswireosTimelineService {
    constructor(private readonly rls: RlsPrismaService) {}

    async apply(workspaceId: string, delivery: TimelineDelivery): Promise<'applied' | 'unmatched' | 'duplicate'> {
        try {
            return await this.rls.withWorkspace(workspaceId, async (tx) => {
                const seen = await tx.newswireosTimelineEvent.findUnique({
                    where: { workspaceId_eventId: { workspaceId, eventId: delivery.id } },
                    select: { id: true },
                });
                if (seen) return 'duplicate';
                const match = delivery.client ? await matchClient(tx, delivery.client) : null;
                await tx.newswireosTimelineEvent.create({
                    data: {
                        workspaceId,
                        eventId: delivery.id,
                        eventType: delivery.type,
                        occurredAt: delivery.occurredAt,
                        payload: delivery.payload as Prisma.InputJsonValue,
                        targetType: match?.target.type ?? null,
                        targetId: match?.target.id ?? null,
                        matchedBy: match?.by ?? null,
                    },
                });
                if (match) await writeEntry(tx, workspaceId, delivery, match.target);
                const email = delivery.client?.email;
                if (email && (delivery.type === 'client.created' || delivery.type === 'am.assigned')) {
                    await keepExclusion(
                        tx,
                        workspaceId,
                        email,
                        delivery.type === 'am.assigned' ? amOf(delivery) : null,
                    );
                }
                return match ? 'applied' : 'unmatched';
            });
        } catch (error) {
            // The same delivery twice at once: the index kept one, which answers for both.
            if (uniqueViolation(error)) return 'duplicate';
            throw error;
        }
    }
}

/** The record an event is about, by the spec's order; null when nothing in the workspace is it. */
export async function matchClient(
    tx: WorkspaceClient,
    client: TimelineClient,
): Promise<{ target: RecordTarget; by: MatchedBy } | null> {
    if (client.bylineContactId && UUID.test(client.bylineContactId)) {
        const p = await tx.person.findFirst({
            where: { id: client.bylineContactId, deletedAt: null },
            select: { id: true },
        });
        if (p) return { target: { type: 'person', id: p.id }, by: 'byline_contact_id' };
    }
    if (client.bylineCompanyId && UUID.test(client.bylineCompanyId)) {
        const c = await tx.company.findFirst({
            where: { id: client.bylineCompanyId, deletedAt: null },
            select: { id: true },
        });
        if (c) return { target: { type: 'company', id: c.id }, by: 'byline_company_id' };
    }
    if (client.email) {
        const p = await tx.person.findFirst({
            where: { emailPrimary: client.email, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
        });
        if (p) return { target: { type: 'person', id: p.id }, by: 'email' };
    }
    if (client.companyDomain) {
        // As a company's domain is matched elsewhere: its registrable domain, or the `www.` form saved before OWN-2c.
        const key = normalisedDomain(client.companyDomain);
        const forms = [key, `www.${key}`];
        const own = await tx.company.findFirst({
            where: { domain: { in: forms }, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
        });
        const id =
            own?.id ??
            (
                await tx.companyDomain.findFirst({
                    where: { domain: { in: forms }, company: { deletedAt: null } },
                    select: { companyId: true },
                })
            )?.companyId;
        if (id) return { target: { type: 'company', id }, by: 'domain' };
    }
    return null;
}

async function writeEntry(
    tx: WorkspaceClient,
    workspaceId: string,
    delivery: TimelineDelivery,
    target: RecordTarget,
): Promise<void> {
    await tx.timelineActivity.create({
        data: {
            workspaceId,
            targetType: target.type,
            targetId: target.id,
            kind: `external.newswireos_${delivery.type.replace('.', '_')}`,
            happenedAt: delivery.occurredAt ?? new Date(),
            actor: { kind: 'external', id: NEWSWIREOS_TIMELINE_SOURCE } satisfies TimelineActor,
            properties: {
                title: delivery.title,
                ...(delivery.url ? { url: delivery.url } : {}),
                ...(delivery.amount ? { amount: delivery.amount } : {}),
                ...(delivery.client?.customerId ? { customerId: delivery.client.customerId } : {}),
            },
            source: NEWSWIREOS_TIMELINE_SOURCE,
            idempotencyKey: delivery.id,
        },
    });
}

/** The account manager an `am.assigned` names: `data.account_manager.name`; null when it carries none. */
export function amOf(delivery: Pick<TimelineDelivery, 'accountManager'>): string | null {
    return delivery.accountManager ? delivery.accountManager.replace(/\s+/g, ' ') : null;
}

/**
 * The client's `account_managed` exclusion, as the client sync keeps it. `am` null (a `client.created`, which names
 * no account manager) leaves a name already kept as it is.
 */
export async function keepExclusion(
    tx: WorkspaceClient,
    workspaceId: string,
    email: string,
    am: string | null,
): Promise<'added' | 'converted' | 'renamed' | 'kept' | 'already'> {
    const address = email.toLowerCase();
    const domain = address.slice(address.lastIndexOf('@') + 1);
    const live = await tx.outreachExclusion.findMany({
        where: {
            removedAt: null,
            OR: [
                { address: { equals: address, mode: 'insensitive' } },
                { domain: { equals: domain, mode: 'insensitive' } },
            ],
        },
        select: { id: true, address: true, source: true, reason: true, accountManagerName: true },
        orderBy: { createdAt: 'asc' },
    });
    const hit = live.find((e) => e.address?.toLowerCase() === address);
    if (hit?.source === NEWSWIREOS_CLIENT_SOURCE) {
        if (am === null || hit.accountManagerName === am) return 'kept';
        await tx.outreachExclusion.update({ where: { id: hit.id }, data: { accountManagerName: am } });
        return 'renamed';
    }
    if (hit?.source === TWENTY_IMPORT_SOURCE && hit.reason === 'account_managed') {
        await tx.outreachExclusion.update({
            where: { id: hit.id },
            data: {
                source: NEWSWIREOS_CLIENT_SOURCE,
                accountManagerName: am,
                externalRef: null,
                note: NEWSWIREOS_CLIENT_NOTE,
            },
        });
        return 'converted';
    }
    if (live.length > 0) return 'already';
    await tx.outreachExclusion.create({
        data: {
            workspaceId,
            address,
            reason: 'account_managed',
            accountManagerName: am,
            source: NEWSWIREOS_CLIENT_SOURCE,
            note: NEWSWIREOS_CLIENT_NOTE,
        },
    });
    return 'added';
}

/**
 * A timeline delivery, read defensively; `null` when the event is not one of the five (the payment hook reads it),
 * `ignored` when it has no id to be de-duplicated on or no title. Exported for its spec.
 */
export function parseTimeline(body: unknown, webhookId: string | undefined): TimelineDelivery | 'ignored' | null {
    const o = record(body) ?? {};
    const type = NEWSWIREOS_TIMELINE_EVENTS.find((t) => t === o['event_type']);
    if (!type) return null;
    const id = text(webhookId, 200) ?? text(o['id'], 200);
    const data = record(o['data']);
    const title = text(data?.['title'], 200);
    if (!id || !data || !title) return 'ignored';
    const occurred = typeof o['occurred_at'] === 'string' ? new Date(o['occurred_at']) : null;
    const amountCents = data['amount_cents'];
    const currency = text(data['currency'], 3);
    const c = record(data['client']);
    const am = record(data['account_manager']);
    const url = text(data['url'], 2048);
    return {
        id,
        type,
        occurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred : null,
        title,
        url: url && /^https?:\/\//i.test(url) ? url : null,
        amount:
            typeof amountCents === 'number' && Number.isSafeInteger(amountCents) && amountCents >= 0 && currency
                ? { amountMinor: amountCents, currency: currency.toUpperCase() }
                : null,
        client: c
            ? {
                  customerId: idText(c['customer_id']),
                  email: lower(c['email'], 320, (v) => v.includes('@')),
                  name: text(c['name'], 200),
                  companyDomain: lower(c['company_domain'], 253, (v) => v.includes('.')),
                  bylineContactId: text(c['byline_contact_id'], 200),
                  bylineCompanyId: text(c['byline_company_id'], 200),
              }
            : null,
        accountManager: text(am?.['name'], 200),
        payload: body,
    };
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, max: number): string | null {
    const s = typeof value === 'string' ? value.trim() : '';
    return s === '' ? null : s.slice(0, max);
}

function idText(value: unknown): string | null {
    return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value, 200);
}

function lower(value: unknown, max: number, valid: (v: string) => boolean): string | null {
    const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return s !== '' && s.length <= max && valid(s) ? s : null;
}
