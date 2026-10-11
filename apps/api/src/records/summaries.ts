import type { Emails } from '@bylinecrm/shared';
import type { RecordSummaryView } from './responses';
import type { MemberSummaryView } from '../workspace/responses';

/**
 * The related records a row carries by name (P1-4a): a person's company and owner, a deal's
 * company, point of contact and owner. Each comes from one `select` in the row's include — one
 * query per relation for the whole page, never one per row — and is shaped here, once.
 *
 * A related record the caller cannot see (another owner's company, under an own-scoped role) or
 * one in the trash comes back as `null`; the id column is still there, as it always was.
 */

export const COMPANY_SUMMARY_SELECT = { id: true, name: true, deletedAt: true } as const;
export const PERSON_SUMMARY_SELECT = {
    id: true,
    nameFirst: true,
    nameLast: true,
    emails: true,
    deletedAt: true,
} as const;
/** A member is named by their person's display name (`users.display_name`, P1-UI-10): one per person. */
export const MEMBER_SUMMARY_SELECT = { id: true, user: { select: { displayName: true } } } as const;

/** A person's name as everything that shows one reads it: first and last, else the primary email. */
export function personName(nameFirst: string, nameLast: string, primaryEmail: string | null | undefined): string {
    return `${nameFirst} ${nameLast}`.trim() || primaryEmail || '';
}

export function companySummary(
    company: { id: string; name: string; deletedAt: Date | null } | null,
): RecordSummaryView | null {
    return company && company.deletedAt === null ? { id: company.id, name: company.name } : null;
}

export function personSummary(
    person: { id: string; nameFirst: string; nameLast: string; emails: unknown; deletedAt: Date | null } | null,
): RecordSummaryView | null {
    if (!person || person.deletedAt !== null) return null;
    const emails = person.emails as Emails | null;
    return { id: person.id, name: personName(person.nameFirst, person.nameLast, emails?.primary) };
}

export function memberSummaryOf(member: { id: string; user: { displayName: string | null } }): MemberSummaryView {
    return { memberId: member.id, name: member.user.displayName };
}

export function memberSummary(
    member: { id: string; user: { displayName: string | null } } | null,
): MemberSummaryView | null {
    return member ? memberSummaryOf(member) : null;
}
