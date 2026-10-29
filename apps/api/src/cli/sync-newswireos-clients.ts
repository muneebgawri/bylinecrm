import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { TWENTY_IMPORT_SOURCE } from '@bylinecrm/shared';
import { parseEnv } from '../config/env';
import { NEWSWIREOS_CLIENT_NOTE as CLIENT_NOTE, NEWSWIREOS_CLIENT_SOURCE } from '../invoices/invoices.constants';
import { fillNewswireosClientsByAddress } from '../invoices/newswireos-client-ids';

/**
 * The source of an exclusion this sync owns: a NewswireOS client account. The hook keeps it current between syncs
 * (PNW-766: `client.created`, `am.assigned`).
 */
export { NEWSWIREOS_CLIENT_SOURCE };

const LOOKUP_REMOVED_NOTE = 'Twenty lead lookup: an owned contact, not a NewswireOS client';
const GONE_NOTE = 'No longer a NewswireOS client';

/**
 * `node dist/cli/sync-newswireos-clients.js --workspace <id> --csv <file> [--apply]` — makes the workspace's
 * `account_managed` exclusions NewswireOS's clients and only them. The CSV is `email,account manager name` per line,
 * exported from NewswireOS (customer and sub-account users), optionally with the client's NewswireOS id as a third
 * field (`email,account manager,client id`): each person at that address who has no client id yet is given it (INV-2),
 * so their deals link to raising an invoice for them in NewswireOS.
 *
 * - A client's address is excluded as `account_managed`, source `newswireos`, with their account manager's name. An
 *   exclusion the Twenty import made for it (a lead lookup) becomes this one; one made otherwise (by hand, a won deal,
 *   a domain) already keeps it out and is left as it is.
 * - Every other lead-lookup exclusion ends: Twenty's lookup is its contacts' ownership, which came here with the
 *   people (anti-poaching acts on that), not a list of clients.
 * - A `newswireos` exclusion whose address is no longer in the CSV ends.
 *
 * Ending is the soft remove (`removedAt`, a note), as an admin's is. Without `--apply` it only prints what it would do
 * (the dry run). Uses the owner connection.
 */
async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const workspaceId = arg('--workspace');
    const csv = arg('--csv');
    if (!workspaceId || !csv) throw new Error('usage: --workspace <id> --csv <file> [--apply]');
    const text = readFileSync(csv, 'utf8');
    const clients = parseClients(text);
    const clientIds = parseClientIds(text);
    const env = parseEnv(process.env);
    const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    const counts = {
        clients: clients.size,
        add: 0,
        convert: 0,
        renamed: 0,
        kept: 0,
        already: 0,
        endLookup: 0,
        endGone: 0,
        withId: clientIds.size,
        idsFilled: 0,
    };
    try {
        const live = await db.outreachExclusion.findMany({
            where: { workspaceId, removedAt: null },
            select: { id: true, address: true, domain: true, source: true, reason: true, accountManagerName: true },
        });
        const byAddress = new Map(live.filter((e) => e.address).map((e) => [e.address!.toLowerCase(), e]));
        const domains = new Set(live.filter((e) => e.domain).map((e) => e.domain!.toLowerCase()));
        const creates: { address: string; am: string | null }[] = [];
        const converts: { id: string; am: string | null }[] = [];
        for (const [address, am] of clients) {
            const hit = byAddress.get(address);
            if (hit?.source === NEWSWIREOS_CLIENT_SOURCE) {
                if ((hit.accountManagerName ?? null) === am) counts.kept += 1;
                else {
                    counts.renamed += 1;
                    converts.push({ id: hit.id, am });
                }
            } else if (hit?.source === TWENTY_IMPORT_SOURCE && hit.reason === 'account_managed') {
                counts.convert += 1;
                converts.push({ id: hit.id, am });
            } else if (hit || domains.has(address.slice(address.lastIndexOf('@') + 1))) {
                counts.already += 1;
            } else {
                counts.add += 1;
                creates.push({ address, am });
                if (creates.length <= 20) console.log(`exclude ${address}${am ? ` (${am})` : ''}`);
            }
        }
        const ends: { id: string; note: string }[] = [];
        for (const e of live) {
            const address = e.address?.toLowerCase();
            if (!address || clients.has(address)) continue;
            if (e.source === TWENTY_IMPORT_SOURCE && e.reason === 'account_managed') {
                counts.endLookup += 1;
                ends.push({ id: e.id, note: LOOKUP_REMOVED_NOTE });
            } else if (e.source === NEWSWIREOS_CLIENT_SOURCE) {
                counts.endGone += 1;
                ends.push({ id: e.id, note: GONE_NOTE });
                console.log(`end ${address}: ${GONE_NOTE}`);
            }
        }
        if (apply) {
            // INV-2: each client's NewswireOS id on the person at that address who has none yet (batched).
            counts.idsFilled = await fillNewswireosClientsByAddress(
                db,
                workspaceId,
                [...clientIds].map(([address, customerId]) => ({ address, customerId })),
            );
            const now = new Date();
            for (const c of creates) {
                await db.outreachExclusion.create({
                    data: {
                        workspaceId,
                        address: c.address,
                        reason: 'account_managed',
                        accountManagerName: c.am,
                        source: NEWSWIREOS_CLIENT_SOURCE,
                        note: CLIENT_NOTE,
                    },
                });
            }
            for (const c of converts) {
                await db.outreachExclusion.update({
                    where: { id: c.id },
                    data: {
                        source: NEWSWIREOS_CLIENT_SOURCE,
                        accountManagerName: c.am,
                        externalRef: null,
                        note: CLIENT_NOTE,
                    },
                });
            }
            for (const note of [LOOKUP_REMOVED_NOTE, GONE_NOTE]) {
                const ids = ends.filter((e) => e.note === note).map((e) => e.id);
                for (let i = 0; i < ids.length; i += 1000) {
                    await db.outreachExclusion.updateMany({
                        where: { id: { in: ids.slice(i, i + 1000) }, removedAt: null },
                        data: { removedAt: now, removedNote: note },
                    });
                }
            }
        }
    } finally {
        await db.$disconnect();
    }
    // Always the outcome, zero included.
    const verb = apply ? '' : 'would ';
    console.log(
        `clients ${counts.clients}: ${verb}add ${counts.add}, ${verb}convert from a lead lookup ${counts.convert}, ` +
            `${verb}rename the account manager ${counts.renamed}, unchanged ${counts.kept}, excluded otherwise ` +
            `${counts.already}; ${verb}end lead lookups ${counts.endLookup}, ${verb}end former clients ${counts.endGone}; ` +
            `client ids in the file ${counts.withId}${apply ? `, given to people ${counts.idsFilled}` : ''}`,
    );
}

function arg(name: string): string | undefined {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : undefined;
}

/**
 * One CSV line: `email,account manager[,client id]`. The client id (INV-2) is the optional last field — NewswireOS's
 * customer id, a UUID or a number — so an account manager whose name has a comma in it stays whole.
 */
function clientLine(line: string): { address: string; am: string | null; customerId: string | null } | null {
    const fields = line.split(',');
    const address = (fields.shift() ?? '').trim().toLowerCase();
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(address)) return null;
    const last = fields.length > 1 ? (fields[fields.length - 1] ?? '').trim() : '';
    const customerId = CLIENT_ID.test(last) ? last : null;
    if (customerId) fields.pop();
    const am = fields.join(',').trim().replace(/\s+/g, ' ');
    return { address, am: am || null, customerId };
}

const CLIENT_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,20})$/i;

/** `email,account manager[,client id]` lines: lower-cased, one per address (the first account manager named wins). */
export function parseClients(text: string): Map<string, string | null> {
    const clients = new Map<string, string | null>();
    for (const line of text.split(/\r?\n/)) {
        const c = clientLine(line);
        if (c && !clients.has(c.address)) clients.set(c.address, c.am);
    }
    return clients;
}

/** INV-2: the client id each address's line carries, when it carries one (the first line for an address wins). */
export function parseClientIds(text: string): Map<string, string> {
    const ids = new Map<string, string>();
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
        const c = clientLine(line);
        if (!c || seen.has(c.address)) continue;
        seen.add(c.address);
        if (c.customerId) ids.set(c.address, c.customerId);
    }
    return ids;
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
