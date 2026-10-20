import type { Emails, Links, Phone, Phones } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { isFreeMailDomain } from '../enrichment/email-domain';

/**
 * People saved more than once (the Twenty import of 2026-10-12 saved some real people two or three times, some
 * linked to different Bigin Contacts). This file is the pure part — who is a duplicate of whom, who owns the
 * merged person, and the SQL that moves one duplicate onto the person it is merged into; `PeopleDedupe` runs it.
 */

/** `auto`: the people share an address — the same person. `review`: only the name and the company (or work domain) agree. */
export type DuplicateTier = 'auto' | 'review';

/** A live person as detection reads it. */
export interface DedupeCandidate {
    id: string;
    nameFirst: string;
    nameLast: string;
    emails: unknown;
    companyId: string | null;
    createdAt: Date;
}

export interface DuplicateGroup {
    tier: DuplicateTier;
    /** Oldest first. */
    personIds: string[];
    /** What ties them: the shared address(es), or the name and company/domain. */
    why: string;
}

/** Lower case, trimmed; `null` for anything that is not an address. */
export function normaliseEmail(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** A person's addresses, normalised, primary first, each once. */
export function emailsOf(emails: unknown): string[] {
    const e = (emails ?? {}) as Partial<Emails>;
    const all = [e.primary, ...(Array.isArray(e.additional) ? e.additional : [])].map(normaliseEmail);
    return [...new Set(all.filter((x): x is string => x !== null))];
}

/** Lower case, accents dropped, punctuation to single spaces: `Rick  Hoganson` = `rick hoganson`. */
export function normaliseName(first: string, last: string): string {
    return `${first} ${last}`
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

class UnionFind {
    private readonly parent = new Map<string, string>();
    find(x: string): string {
        let p = this.parent.get(x) ?? x;
        if (p !== x) {
            p = this.find(p);
            this.parent.set(x, p);
        }
        return p;
    }
    union(a: string, b: string): void {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra !== rb) this.parent.set(rb, ra);
    }
}

/**
 * Groups live people of one workspace. `auto`: connected by any shared address (primary or additional, case and
 * whitespace ignored) — transitively, so A~B by one address and B~C by another is one group. `review`: two or more
 * of those groups (or single people) whose full name agrees (two words at least) and that share a company or a
 * work domain (free mail says nothing); merging it merges the auto groups inside it too. Deterministic: groups and
 * their people are ordered oldest first.
 */
export function groupDuplicates(people: readonly DedupeCandidate[]): DuplicateGroup[] {
    const sorted = [...people].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const order = new Map(sorted.map((p, i) => [p.id, i]));
    const byOrder = (a: string, b: string) => order.get(a)! - order.get(b)!;

    const byEmail = new UnionFind();
    const holders = new Map<string, string[]>();
    for (const p of sorted) {
        for (const email of emailsOf(p.emails)) {
            const first = holders.get(email)?.[0];
            if (first) byEmail.union(first, p.id);
            holders.set(email, [...(holders.get(email) ?? []), p.id]);
        }
    }
    const components = new Map<string, string[]>();
    for (const p of sorted) {
        const root = byEmail.find(p.id);
        components.set(root, [...(components.get(root) ?? []), p.id]);
    }
    const sharedOf = (ids: readonly string[]) =>
        [...holders.entries()].filter(([, h]) => h.filter((id) => ids.includes(id)).length > 1).map(([e]) => e);

    const groups: DuplicateGroup[] = [];
    for (const ids of components.values()) {
        if (ids.length > 1)
            groups.push({ tier: 'auto', personIds: ids, why: `shared email ${sharedOf(ids).join(' ')}` });
    }

    // Review: unite the auto components by (name, company) and (name, work domain).
    const byName = new UnionFind();
    const keyHolder = new Map<string, string>();
    const keysOf = new Map<string, Set<string>>();
    const person = new Map(sorted.map((p) => [p.id, p]));
    for (const [root, ids] of components) {
        for (const id of ids) {
            const p = person.get(id)!;
            const name = normaliseName(p.nameFirst, p.nameLast);
            if (!name.includes(' ')) continue;
            const keys = [
                ...(p.companyId ? [`${name}|company:${p.companyId}`] : []),
                ...emailsOf(p.emails)
                    .map((e) => e.slice(e.lastIndexOf('@') + 1))
                    .filter((d) => !isFreeMailDomain(d))
                    .map((d) => `${name}|domain:${d}`),
            ];
            for (const key of keys) {
                const other = keyHolder.get(key);
                if (other) byName.union(other, root);
                else keyHolder.set(key, root);
                keysOf.set(root, (keysOf.get(root) ?? new Set()).add(key));
            }
        }
    }
    const supers = new Map<string, string[]>();
    for (const root of components.keys()) {
        const s = byName.find(root);
        supers.set(s, [...(supers.get(s) ?? []), root]);
    }
    for (const roots of supers.values()) {
        if (roots.length < 2) continue;
        const ids = roots.flatMap((r) => components.get(r)!).sort(byOrder);
        const counts = new Map<string, number>();
        for (const r of roots) for (const k of keysOf.get(r) ?? []) counts.set(k, (counts.get(k) ?? 0) + 1);
        const shared = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k.replace('|', ' at '));
        groups.push({ tier: 'review', personIds: ids, why: `same name ${shared.join(', ')}` });
    }
    return groups.sort((a, b) => byOrder(a.personIds[0]!, b.personIds[0]!) || a.tier.localeCompare(b.tier));
}

// ─── Ownership ──────────────────────────────────────────────────────────────────────────────────

/** A member reaching one of the duplicates: a CRM send, a sequence step, mail they sent from Gmail, a note or task. */
export interface FirstContact {
    memberId: string;
    at: Date;
    how: 'email' | 'sequence' | 'synced email' | 'note' | 'task';
    personId: string;
}

export interface OwnerFacts {
    id: string;
    createdAt: Date;
    ownerId: string | null;
    createdBy: unknown;
}

export interface OwnerDecision {
    /** Null when no member ever contacted or saved any of them, and none owns the earliest. */
    ownerId: string | null;
    survivorId: string;
    why: string;
}

/**
 * The member who first contacted or first saved the lead owns the merged person: the earliest contact by a member
 * still in the workspace (`contacts`), else the creator of the earliest-saved duplicate when a member created it,
 * else that duplicate's owner. The survivor is the oldest duplicate that owner already owns, else the oldest.
 */
export function chooseOwner(
    people: readonly OwnerFacts[],
    contacts: readonly FirstContact[],
    activeMembers: ReadonlySet<string>,
): OwnerDecision {
    const oldest = [...people].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const first = [...contacts]
        .filter((c) => activeMembers.has(c.memberId))
        .sort((a, b) => a.at.getTime() - b.at.getTime() || a.memberId.localeCompare(b.memberId))[0];
    let ownerId: string | null;
    let why: string;
    if (first) {
        ownerId = first.memberId;
        why = `first contact: ${first.how} ${first.at.toISOString().slice(0, 10)} (person ${first.personId})`;
    } else {
        const earliest = oldest[0]!;
        const by = (earliest.createdBy ?? {}) as { kind?: string; id?: string | null };
        if (by.kind === 'member' && by.id && activeMembers.has(by.id)) {
            ownerId = by.id;
            why = `no contact; first saved by this member ${earliest.createdAt.toISOString().slice(0, 10)}`;
        } else if (earliest.ownerId && activeMembers.has(earliest.ownerId)) {
            ownerId = earliest.ownerId;
            why = `no contact; owner of the earliest-saved duplicate (${earliest.createdAt.toISOString().slice(0, 10)})`;
        } else {
            ownerId = null;
            why = 'no member contacted or saved them; owner unchanged';
        }
    }
    const survivor = (ownerId ? oldest.find((p) => p.ownerId === ownerId) : undefined) ?? oldest[0]!;
    return { ownerId: ownerId ?? survivor.ownerId, survivorId: survivor.id, why };
}

/** Every member contact with any of `personIds`, in the workspace: the facts `chooseOwner` reads. */
export async function firstContacts(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    personIds: readonly string[],
): Promise<FirstContact[]> {
    const ids = [...personIds];
    const rows = await tx.$queryRaw<
        { member_id: string | null; at: Date; how: FirstContact['how']; person_id: string }[]
    >`
        SELECT o.sender_member_id::text AS member_id, o.sent_at AS at,
               CASE WHEN o.sequence_enrolment_id IS NULL THEN 'email' ELSE 'sequence' END AS how,
               o.person_id::text AS person_id
          FROM mail_outbound o
         WHERE o.workspace_id = ${workspaceId}::uuid AND o.sent_at IS NOT NULL AND o.person_id::text = ANY(${ids})
        UNION ALL
        SELECT f.member_id::text, m.sent_at, 'synced email', t.person_id::text
          FROM mail_participants t
          JOIN mail_messages m ON m.id = t.message_id AND m.direction = 'outbound'
          JOIN mail_participants f ON f.message_id = m.id AND f.role = 'from' AND f.member_id IS NOT NULL
         WHERE t.workspace_id = ${workspaceId}::uuid AND t.role <> 'from' AND t.person_id::text = ANY(${ids})
        UNION ALL
        SELECT n.created_by->>'id', n.created_at, 'note', nt.target_id::text
          FROM note_targets nt JOIN notes n ON n.id = nt.note_id
         WHERE nt.workspace_id = ${workspaceId}::uuid AND nt.target_type = 'person' AND nt.target_id::text = ANY(${ids})
           AND n.created_by->>'kind' = 'member'
        UNION ALL
        SELECT k.created_by->>'id', k.created_at, 'task', kt.target_id::text
          FROM task_targets kt JOIN tasks k ON k.id = kt.task_id
         WHERE kt.workspace_id = ${workspaceId}::uuid AND kt.target_type = 'person' AND kt.target_id::text = ANY(${ids})
           AND k.created_by->>'kind' = 'member'`;
    return rows
        .filter((r) => r.member_id)
        .map((r) => ({ memberId: r.member_id!, at: r.at, how: r.how, personId: r.person_id }));
}

// ─── Merging one duplicate ──────────────────────────────────────────────────────────────────────

/** What one merge moved, per kind of thing; every kind is reported, zero included. */
export interface PersonMergeCounts {
    noteLinks: number;
    taskLinks: number;
    files: number;
    timelineEntries: number;
    enrichmentAnswers: number;
    mailParticipants: number;
    sends: number;
    meetings: number;
    enrolments: number;
    enrolmentsStopped: number;
    deals: number;
    suppressions: number;
    unsubscribeTokens: number;
    trackingHits: number;
    guardrailEvents: number;
    bylineLeads: number;
    transferHistory: number;
    openOffersCancelled: number;
    twentyLinks: number;
    biginLinks: number;
    contactReuses: number;
    mergedPointers: number;
}

export const EMPTY_PERSON_COUNTS: PersonMergeCounts = {
    noteLinks: 0,
    taskLinks: 0,
    files: 0,
    timelineEntries: 0,
    enrichmentAnswers: 0,
    mailParticipants: 0,
    sends: 0,
    meetings: 0,
    enrolments: 0,
    enrolmentsStopped: 0,
    deals: 0,
    suppressions: 0,
    unsubscribeTokens: 0,
    trackingHits: 0,
    guardrailEvents: 0,
    bylineLeads: 0,
    transferHistory: 0,
    openOffersCancelled: 0,
    twentyLinks: 0,
    biginLinks: 0,
    contactReuses: 0,
    mergedPointers: 0,
};

/** The fields of a person the merge combines. */
export interface MergeablePerson {
    id: string;
    nameFirst: string;
    nameLast: string;
    emails: unknown;
    phones: unknown;
    links: unknown;
    jobTitle: string | null;
    source: string | null;
    country: string | null;
    city: string | null;
    avatarUrl: string | null;
    companyId: string | null;
    custom: unknown;
}

/**
 * The survivor's fields after taking the duplicate in: its own values win; a blank takes the duplicate's. Every
 * address is kept — the survivor's primary (else the duplicate's) and all the others as additional, each once.
 */
export function combined(survivor: MergeablePerson, dup: MergeablePerson) {
    const all = [...new Set([...emailsOf(survivor.emails), ...emailsOf(dup.emails)])];
    const primary =
        normaliseEmail((survivor.emails as Emails | null)?.primary) ??
        normaliseEmail((dup.emails as Emails | null)?.primary) ??
        all[0] ??
        null;
    const emails: Emails = { primary, additional: all.filter((e) => e !== primary) };
    const sp = (survivor.phones ?? { primary: null, additional: [] }) as Phones;
    const dp = (dup.phones ?? { primary: null, additional: [] }) as Phones;
    const phoneKey = (p: Phone) => `${p.countryCode}:${p.number.replace(/\D/g, '')}`;
    const phonePrimary = sp.primary ?? dp.primary ?? null;
    const seen = new Set(phonePrimary ? [phoneKey(phonePrimary)] : []);
    const phoneAdditional: Phone[] = [];
    for (const p of [sp.primary, ...(sp.additional ?? []), dp.primary, ...(dp.additional ?? [])]) {
        if (!p || seen.has(phoneKey(p))) continue;
        seen.add(phoneKey(p));
        phoneAdditional.push(p);
    }
    const sl = (survivor.links ?? {}) as Partial<Links>;
    const dl = (dup.links ?? {}) as Partial<Links>;
    const blank = (s: string | null | undefined) => (s && s.trim() !== '' ? s : null);
    return {
        nameFirst: blank(survivor.nameFirst) ?? dup.nameFirst,
        nameLast: blank(survivor.nameLast) ?? dup.nameLast,
        emails,
        phones: { primary: phonePrimary, additional: phoneAdditional } satisfies Phones,
        links: { linkedin: sl.linkedin ?? dl.linkedin ?? null, x: sl.x ?? dl.x ?? null } satisfies Links,
        jobTitle: blank(survivor.jobTitle) ?? dup.jobTitle,
        source: blank(survivor.source) ?? dup.source,
        country: survivor.country ?? dup.country,
        city: blank(survivor.city) ?? dup.city,
        avatarUrl: survivor.avatarUrl ?? dup.avatarUrl,
        companyId: survivor.companyId ?? dup.companyId,
        custom: { ...((dup.custom ?? {}) as object), ...((survivor.custom ?? {}) as object) },
    };
}

/**
 * Moves everything that points at `dupId` onto `survivorId`, in the transaction given (the owner connection: the
 * app role may not move timeline entries). Notes, tasks, files, timeline, enrichment answers, mail (participants
 * and CRM sends), meetings, sequence enrolments (one per sequence and person: the duplicate's enrolment in a
 * sequence the survivor is already in is stopped and stays on the duplicate), deals it is the contact of,
 * suppressions (they stay per address), unsubscribe tokens, tracking, guardrail events, Byline leads, transfer
 * history (an open offer is cancelled), the Twenty and Bigin importers' links (so the next sync updates the
 * survivor), Bigin Contact reuse records and earlier merges' pointers. A link the survivor already has is kept once. Does not touch the two people's own rows.
 */
export async function moveRelated(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    dupId: string,
    survivorId: string,
): Promise<PersonMergeCounts> {
    const ws = workspaceId;
    const dup = dupId;
    const kept = survivorId;
    const n = (rows: number | bigint) => Number(rows);
    const c: PersonMergeCounts = { ...EMPTY_PERSON_COUNTS };

    await tx.$executeRaw`DELETE FROM note_targets t WHERE t.workspace_id = ${ws}::uuid AND t.target_type = 'person' AND t.target_id = ${dup}::uuid
        AND EXISTS (SELECT 1 FROM note_targets k WHERE k.note_id = t.note_id AND k.target_type = 'person' AND k.target_id = ${kept}::uuid)`;
    c.noteLinks = n(
        await tx.$executeRaw`UPDATE note_targets SET target_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND target_type = 'person' AND target_id = ${dup}::uuid`,
    );
    await tx.$executeRaw`DELETE FROM task_targets t WHERE t.workspace_id = ${ws}::uuid AND t.target_type = 'person' AND t.target_id = ${dup}::uuid
        AND EXISTS (SELECT 1 FROM task_targets k WHERE k.task_id = t.task_id AND k.target_type = 'person' AND k.target_id = ${kept}::uuid)`;
    c.taskLinks = n(
        await tx.$executeRaw`UPDATE task_targets SET target_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND target_type = 'person' AND target_id = ${dup}::uuid`,
    );
    c.files = n(
        await tx.$executeRaw`UPDATE attachments SET target_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND target_type = 'person' AND target_id = ${dup}::uuid`,
    );
    await tx.$executeRaw`DELETE FROM timeline_activities t WHERE t.workspace_id = ${ws}::uuid AND t.target_type = 'person' AND t.target_id = ${dup}::uuid
        AND EXISTS (SELECT 1 FROM timeline_activities k WHERE k.workspace_id = t.workspace_id AND k.event_id = t.event_id
                    AND k.target_type = 'person' AND k.target_id = ${kept}::uuid)`;
    c.timelineEntries = n(
        await tx.$executeRaw`UPDATE timeline_activities SET target_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND target_type = 'person' AND target_id = ${dup}::uuid`,
    );
    c.enrichmentAnswers = n(
        await tx.$executeRaw`UPDATE enrichment_answers SET record_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND object = 'person' AND record_id = ${dup}::uuid`,
    );
    c.mailParticipants = n(
        await tx.$executeRaw`UPDATE mail_participants SET person_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND person_id = ${dup}::uuid`,
    );
    c.sends = n(
        await tx.$executeRaw`UPDATE mail_outbound SET person_id = ${kept}::uuid, updated_at = now() WHERE workspace_id = ${ws}::uuid AND person_id = ${dup}::uuid`,
    );
    c.meetings = n(
        await tx.$executeRaw`UPDATE calendar_event_participants SET person_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND person_id = ${dup}::uuid`,
    );
    c.enrolments = n(
        await tx.$executeRaw`UPDATE sequence_enrolments e SET person_id = ${kept}::uuid, updated_at = now()
        WHERE e.workspace_id = ${ws}::uuid AND e.person_id = ${dup}::uuid
          AND NOT EXISTS (SELECT 1 FROM sequence_enrolments k WHERE k.sequence_id = e.sequence_id AND k.person_id = ${kept}::uuid)`,
    );
    c.enrolmentsStopped = n(
        await tx.$executeRaw`UPDATE sequence_enrolments SET status = 'stopped', stop_reason = 'person_deleted',
            stop_detail = ${`merged into ${kept}`}, stopped_at = now(), next_run_at = NULL, updated_at = now()
        WHERE workspace_id = ${ws}::uuid AND person_id = ${dup}::uuid AND status IN ('active', 'held')`,
    );
    c.deals = n(
        await tx.$executeRaw`UPDATE opportunities SET point_of_contact_id = ${kept}::uuid, updated_at = now() WHERE workspace_id = ${ws}::uuid AND point_of_contact_id = ${dup}::uuid`,
    );
    c.suppressions = n(
        await tx.$executeRaw`UPDATE suppressions SET person_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND person_id = ${dup}::uuid`,
    );
    c.unsubscribeTokens = n(
        await tx.$executeRaw`UPDATE unsubscribe_tokens SET person_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND person_id = ${dup}::uuid`,
    );
    c.trackingHits = n(
        await tx.$executeRaw`UPDATE tracking_hits SET person_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND person_id = ${dup}::uuid`,
    );
    c.guardrailEvents = n(
        await tx.$executeRaw`UPDATE guardrail_events SET person_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND person_id = ${dup}::uuid`,
    );
    c.bylineLeads = n(
        await tx.$executeRaw`UPDATE byline_leads SET person_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND person_id = ${dup}::uuid`,
    );
    c.openOffersCancelled = n(
        await tx.$executeRaw`UPDATE ownership_transfers SET status = 'cancelled', note = 'The person was merged into another.', decided_at = now(), updated_at = now()
        WHERE workspace_id = ${ws}::uuid AND object = 'person' AND record_id = ${dup}::uuid AND status = 'proposed'`,
    );
    c.transferHistory = n(
        await tx.$executeRaw`UPDATE ownership_transfers SET record_id = ${kept}::uuid, updated_at = now() WHERE workspace_id = ${ws}::uuid AND object = 'person' AND record_id = ${dup}::uuid`,
    );
    c.twentyLinks = n(
        await tx.$executeRaw`UPDATE twenty_import_links SET local_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND local_type = 'person' AND local_id = ${dup}::uuid`,
    );
    c.biginLinks = n(
        await tx.$executeRaw`UPDATE bigin_import_links SET local_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND local_type = 'person' AND local_id = ${dup}::uuid`,
    );
    // A reuse between the two people merged stays as it was (it cannot point from a person to itself).
    c.contactReuses =
        n(
            await tx.$executeRaw`UPDATE bigin_contact_reuses SET previous_person_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND previous_person_id = ${dup}::uuid AND new_person_id <> ${kept}::uuid`,
        ) +
        n(
            await tx.$executeRaw`UPDATE bigin_contact_reuses SET new_person_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND new_person_id = ${dup}::uuid AND previous_person_id <> ${kept}::uuid`,
        );
    // People merged into the duplicate earlier now point at the survivor.
    c.mergedPointers = n(
        await tx.$executeRaw`UPDATE people SET merged_into_id = ${kept}::uuid WHERE workspace_id = ${ws}::uuid AND merged_into_id = ${dup}::uuid`,
    );
    return c;
}

export function addCounts(total: PersonMergeCounts, c: PersonMergeCounts): void {
    for (const key of Object.keys(total) as (keyof PersonMergeCounts)[]) total[key] += c[key];
}
