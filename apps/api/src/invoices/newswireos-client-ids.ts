import { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** How many rows one statement of the CSV sync's id fill touches (batched, never the whole table at once). */
export const CLIENT_ID_BATCH = 500;

/**
 * INV-2: the one writer of the NewswireOS client a CRM record is (`newswireos_customer_id`), which a deal's "Raise
 * invoice in NewswireOS" link opens. Every source goes through it, with the same rule:
 *
 * - **The won-deal push** (PNW-766) is NewswireOS's own answer for the person, so it `replace`s theirs.
 * - **Everything else fills a gap** (`fill`): a timeline event naming the client, the client CSV. A record that
 *   already has its client keeps it — an event about a colleague, or an older export, never moves it.
 * - **A company keeps the first client it was given**, whichever source gave it: it may hold several clients, one
 *   per contact, each kept on its person.
 */
export async function keepNewswireosClient(
    tx: WorkspaceClient | Prisma.TransactionClient,
    record: { type: 'person' | 'company'; id: string },
    customerId: string,
    mode: 'replace' | 'fill' = 'fill',
): Promise<boolean> {
    const id = customerId.trim();
    if (!id) return false;
    const where = mode === 'replace' && record.type === 'person' ? {} : { newswireosCustomerId: null };
    const { count } =
        record.type === 'person'
            ? await tx.person.updateMany({ where: { id: record.id, ...where }, data: { newswireosCustomerId: id } })
            : await tx.company.updateMany({ where: { id: record.id, ...where }, data: { newswireosCustomerId: id } });
    return count > 0;
}

/**
 * The CSV sync's fill: for each (address, client id), the live person with that primary address who has no client yet
 * takes it — one statement per batch of {@link CLIENT_ID_BATCH}, so a 10,000-client export is twenty statements, not
 * ten thousand. Returns how many people were given their client.
 */
export async function fillNewswireosClientsByAddress(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    clients: ReadonlyArray<{ address: string; customerId: string }>,
): Promise<number> {
    let filled = 0;
    for (let i = 0; i < clients.length; i += CLIENT_ID_BATCH) {
        const batch = clients.slice(i, i + CLIENT_ID_BATCH);
        const rows = Prisma.join(batch.map((c) => Prisma.sql`(${c.address.toLowerCase()}, ${c.customerId.trim()})`));
        filled += await tx.$executeRaw`
            UPDATE "people" AS p SET "newswireos_customer_id" = v.customer_id, "updated_at" = now()
            FROM (VALUES ${rows}) AS v(address, customer_id)
            WHERE p."workspace_id" = ${workspaceId}::uuid
              AND p."email_primary" = v.address
              AND p."deleted_at" IS NULL
              AND p."newswireos_customer_id" IS NULL`;
    }
    return filled;
}

/** The client id a stored NewswireOS delivery names (`data.client.customer_id`), as the hook reads it; null for none. */
export function customerIdOf(payload: unknown): string | null {
    const data = (payload as { data?: { client?: { customer_id?: unknown } } } | null)?.data;
    const id = data?.client?.customer_id;
    if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
    return typeof id === 'string' && id.trim() !== '' ? id.trim().slice(0, 200) : null;
}
