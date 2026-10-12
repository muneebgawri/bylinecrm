import { Injectable } from '@nestjs/common';
import {
    ENRICHMENT_DEFAULTS,
    ENRICHMENT_SOURCES,
    type EnrichmentSettings,
    type EnrichmentSettingsView,
    type EnrichmentSource,
} from '@bylinecrm/shared';
import type { EnrichmentSettings as Row } from '@prisma/client';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';

/**
 * Which sources a workspace asks and how long an answer stands (P4-2): a row is an override of the
 * default (every free source on, 90 days); the stored shape is the sources turned *off*, so a source
 * added later is on everywhere without a migration.
 */
@Injectable()
export class EnrichmentSettingsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    settings(): Promise<EnrichmentSettingsView> {
        this.current();
        return this.rls.withWorkspace((tx) => this.viewIn(tx));
    }

    async putSettings(input: EnrichmentSettings): Promise<EnrichmentSettingsView> {
        const context = this.current();
        const disabledSources = ENRICHMENT_SOURCES.filter((s) => !input.sources[s]);
        return this.rls.withWorkspace(async (tx) => {
            await tx.enrichmentSettings.upsert({
                where: { workspaceId: context.workspaceId },
                create: {
                    workspaceId: context.workspaceId,
                    reaskAfterDays: input.reaskAfterDays,
                    disabledSources,
                    updatedByMemberId: context.memberId ?? null,
                },
                update: {
                    reaskAfterDays: input.reaskAfterDays,
                    disabledSources,
                    updatedByMemberId: context.memberId ?? null,
                },
            });
            return this.viewIn(tx);
        });
    }

    /** The settings in force, read in `tx`. */
    async settingsIn(tx: WorkspaceClient): Promise<EnrichmentSettings> {
        return settingsOf(await tx.enrichmentSettings.findFirst());
    }

    private async viewIn(tx: WorkspaceClient): Promise<EnrichmentSettingsView> {
        const row = await tx.enrichmentSettings.findFirst();
        const settings = settingsOf(row);
        return {
            ...settings,
            isDefault:
                settings.reaskAfterDays === ENRICHMENT_DEFAULTS.reaskAfterDays &&
                ENRICHMENT_SOURCES.every((s) => settings.sources[s]),
            updatedAt: row?.updatedAt.toISOString() ?? null,
        };
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('EnrichmentSettingsService is used inside a workspace scope');
        return context;
    }
}

function settingsOf(row: Row | null): EnrichmentSettings {
    if (!row)
        return { reaskAfterDays: ENRICHMENT_DEFAULTS.reaskAfterDays, sources: { ...ENRICHMENT_DEFAULTS.sources } };
    const off = new Set(row.disabledSources);
    return {
        reaskAfterDays: row.reaskAfterDays,
        sources: Object.fromEntries(ENRICHMENT_SOURCES.map((s) => [s, !off.has(s)])) as Record<
            EnrichmentSource,
            boolean
        >,
    };
}
