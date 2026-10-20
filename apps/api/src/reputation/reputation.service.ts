import { Injectable } from '@nestjs/common';
import type { ReputationSettings } from '@bylinecrm/shared';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { pickReputationSettings, reputationSettingsIn } from './settings';

/** The workspace's sender-reputation thresholds (REP-1): read by reviewers, set by admins. */
@Injectable()
export class ReputationService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    settings(): Promise<ReputationSettings> {
        return this.rls.withWorkspace((tx) => reputationSettingsIn(tx));
    }

    async updateSettings(input: ReputationSettings): Promise<ReputationSettings> {
        const workspaceId = this.context.get()!.workspaceId;
        return this.rls.withWorkspace(async (tx) =>
            pickReputationSettings(
                await tx.reputationSettings.upsert({
                    where: { workspaceId },
                    create: { workspaceId, ...input },
                    update: input,
                }),
            ),
        );
    }
}
