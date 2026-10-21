import { PrismaClient } from '@prisma/client';
import { WON_DEAL_EXCLUSION_SOURCE, type WonExclusionScope } from '@bylinecrm/shared';
import { parseEnv } from '../config/env';
import { exclusionTarget } from '../customers/exclusion-target';

/**
 * `node dist/cli/backfill-won-exclusions.js [--apply] [--workspace <id>]` — run once on the server, inside the api
 * container, after #242 deploys. Every live deal in a won stage gets the outreach exclusion a deal won from now on
 * gets on its own (`source: won_deal`, `externalRef` the deal): its point of contact's primary address, or — when
 * the workspace chose `domain` — their company's domain (free mail falls back to the address). An address or domain
 * already excluded (by anyone) is left as it is; a deal with no point of contact, or one without an address, is
 * printed and skipped. Without `--apply` it only prints what it would add (the dry run). Uses the owner connection.
 */
async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const at = process.argv.indexOf('--workspace');
    const workspaceId = at > 0 ? process.argv[at + 1] : undefined;
    const env = parseEnv(process.env);
    const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    const counts = { deals: 0, add: 0, already: 0, noAddress: 0 };
    try {
        const scopes = new Map(
            (await db.customerExclusionSettings.findMany()).map((s) => [
                s.workspaceId,
                s.wonExclusionScope as WonExclusionScope,
            ]),
        );
        const deals = await db.opportunity.findMany({
            where: { deletedAt: null, stage: { kind: 'won' }, ...(workspaceId ? { workspaceId } : {}) },
            select: {
                id: true,
                workspaceId: true,
                name: true,
                company: { select: { domain: true } },
                pointOfContact: { select: { emailPrimary: true, company: { select: { domain: true } } } },
            },
            orderBy: { createdAt: 'asc' },
        });
        // What is excluded already, per workspace, plus what this run adds as it goes.
        const live = new Set(
            (
                await db.outreachExclusion.findMany({
                    where: { removedAt: null, ...(workspaceId ? { workspaceId } : {}) },
                    select: { workspaceId: true, address: true, domain: true },
                })
            ).map((e) => `${e.workspaceId} ${e.address ?? `@${e.domain}`}`),
        );
        for (const deal of deals) {
            counts.deals += 1;
            const target = exclusionTarget(
                scopes.get(deal.workspaceId) ?? 'address',
                deal.pointOfContact?.emailPrimary ?? null,
                deal.company?.domain ?? deal.pointOfContact?.company?.domain ?? null,
            );
            if (!target) {
                counts.noAddress += 1;
                console.log(`deal ${deal.id} (${deal.name}): no point of contact with an address; skipped`);
                continue;
            }
            const domain = target.domain ?? target.address.slice(target.address.lastIndexOf('@') + 1);
            const keys = [
                `${deal.workspaceId} @${domain}`,
                ...(target.address ? [`${deal.workspaceId} ${target.address}`] : []),
            ];
            if (keys.some((k) => live.has(k))) {
                counts.already += 1;
                continue;
            }
            const what = target.address ?? `@${target.domain}`;
            console.log(`deal ${deal.id} (${deal.name}): exclude ${what}`);
            counts.add += 1;
            live.add(keys[keys.length - 1]!);
            if (apply) {
                await db.outreachExclusion.create({
                    data: {
                        workspaceId: deal.workspaceId,
                        address: target.address ?? null,
                        domain: target.domain ?? null,
                        reason: 'customer',
                        source: WON_DEAL_EXCLUSION_SOURCE,
                        externalRef: deal.id,
                        note: `Won deal: ${deal.name}`.slice(0, 500),
                    },
                });
            }
        }
    } finally {
        await db.$disconnect();
    }
    // Always the outcome, zero included.
    console.log(
        `won deals ${counts.deals}: ${apply ? 'added' : 'would add'} ${counts.add}; already excluded ${counts.already}; ` +
            `no address ${counts.noAddress}`,
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
