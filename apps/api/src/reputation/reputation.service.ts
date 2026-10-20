import { Injectable } from '@nestjs/common';
import type { ReputationSettings, ReputationSettingsView } from '@bylinecrm/shared';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { pickReputationSettings, primaryDomainIn, reputationSettingsIn } from './settings';

/** The workspace's sender-reputation thresholds (REP-1): read by reviewers, set by admins. */
@Injectable()
export class ReputationService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    settings(): Promise<ReputationSettingsView> {
        return this.rls.withWorkspace(async (tx) => {
            const s = await reputationSettingsIn(tx);
            return { ...s, effectivePrimaryDomain: await primaryDomainIn(tx, s) };
        });
    }

    async updateSettings(input: ReputationSettings): Promise<ReputationSettingsView> {
        const workspaceId = this.context.get()!.workspaceId;
        return this.rls.withWorkspace(async (tx) => {
            const s = pickReputationSettings(
                await tx.reputationSettings.upsert({
                    where: { workspaceId },
                    create: { workspaceId, ...input },
                    update: input,
                }),
            );
            return { ...s, effectivePrimaryDomain: await primaryDomainIn(tx, s) };
        });
    }
}
