import type { Emails, RecordTarget } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * Who an address is (PAR-028): a live person whose primary or additional email it is, and a
 * member whose sign-in email it is. One rule, used when a message is imported and again whenever a
 * person gains, loses, deletes or restores an address — so earlier mail follows the person.
 *
 * An address belongs to at most one person: the one whose **primary** email it is (unique in the
 * workspace), else the earliest-created person listing it as an additional email. Runs in the
 * caller's transaction, so the workspace policy (and an own-scoped caller's owner policy) applies.
 */

/** The live person each address belongs to; an address with no person is absent. */
export async function personsByAddress(
    tx: WorkspaceClient,
    addresses: readonly string[],
): Promise<Map<string, string>> {
    if (addresses.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ address: string; person_id: string | null }[]>`
        SELECT a.address, (${PERSON_FOR_ADDRESS}) AS person_id
        FROM unnest(${[...new Set(addresses)]}::text[]) AS a(address)`;
    return new Map(rows.filter((r) => r.person_id !== null).map((r) => [r.address, r.person_id!]));
}

/** The member each address signs in with; an address with no member is absent. */
export async function membersByAddress(
    tx: WorkspaceClient,
    addresses: readonly string[],
): Promise<Map<string, string>> {
    if (addresses.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ address: string; member_id: string }[]>`
        SELECT u.email AS address, m.id AS member_id
        FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE u.email = ANY(${[...new Set(addresses)]}::text[])`;
    return new Map(rows.map((r) => [r.address, r.member_id]));
}

/**
 * Re-points every participant with one of `addresses` at the person the address belongs to now
 * (or at no one). Returns how many participants changed. Idempotent.
 */
export async function rematchAddresses(tx: WorkspaceClient, addresses: readonly string[]): Promise<number> {
    if (addresses.length === 0) return 0;
    return tx.$executeRaw`
        UPDATE mail_participants mp
        SET person_id = x.person_id
        FROM (
            SELECT a.address, (${PERSON_FOR_ADDRESS}) AS person_id
            FROM unnest(${[...new Set(addresses)]}::text[]) AS a(address)
        ) x
        WHERE mp.address = x.address AND mp.person_id IS DISTINCT FROM x.person_id`;
}

/** The subquery choosing an address's person: primary first, then the earliest additional. */
const PERSON_FOR_ADDRESS = Prisma.sql`
    SELECT p.id FROM people p
    WHERE p.deleted_at IS NULL
      AND (p.email_primary = a.address
           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.emails -> 'additional') e WHERE lower(e) = a.address))
    ORDER BY (p.email_primary = a.address) DESC NULLS LAST, p.created_at ASC, p.id ASC
    LIMIT 1`;

/** Every address on a person's record, lower case. */
export function addressesOf(emails: Emails | null | undefined): string[] {
    if (!emails) return [];
    return [emails.primary, ...emails.additional]
        .filter((e): e is string => typeof e === 'string' && e !== '')
        .map((e) => e.toLowerCase());
}

/**
 * The records mail with these people is on: each live person, their company, and the open deals
 * they are the point of contact for. Order: people, companies, deals.
 */
export async function recordTargetsForPeople(
    tx: WorkspaceClient,
    personIds: readonly string[],
): Promise<RecordTarget[]> {
    if (personIds.length === 0) return [];
    const ids = [...new Set(personIds)];
    const people = await tx.person.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, companyId: true },
        orderBy: { id: 'asc' },
    });
    if (people.length === 0) return [];
    const livePeople = people.map((p) => p.id);
    const companyIds = [...new Set(people.map((p) => p.companyId).filter((c): c is string => c !== null))];
    const companies = companyIds.length
        ? await tx.company.findMany({
              where: { id: { in: companyIds }, deletedAt: null },
              select: { id: true },
              orderBy: { id: 'asc' },
          })
        : [];
    const deals = await tx.opportunity.findMany({
        where: { pointOfContactId: { in: livePeople }, deletedAt: null, stage: { kind: 'open' } },
        select: { id: true },
        orderBy: { id: 'asc' },
    });
    return [
        ...livePeople.map((id) => ({ type: 'person' as const, id })),
        ...companies.map((c) => ({ type: 'company' as const, id: c.id })),
        ...deals.map((d) => ({ type: 'opportunity' as const, id: d.id })),
    ];
}
