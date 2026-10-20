import { Injectable } from '@nestjs/common';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import type { BylineLink } from './byline-api.port';

/** A workspace's BylineAI API link as the adapters use it, with whether verification goes to BylineAI. */
export interface WorkspaceBylineLink extends BylineLink {
    verify: boolean;
}

/** Reads a workspace's BylineAI API link (BYL-2) for the enrichment and verification adapters. */
@Injectable()
export class BylineLinks {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly secrets: SecretBox,
    ) {}

    /** The link, or null when the workspace has not given BylineAI's address and key. */
    async linkFor(workspaceId: string): Promise<WorkspaceBylineLink | null> {
        const row = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.bylineSettings.findFirst({
                select: { baseUrl: true, apiKeyCiphertext: true, verifyWithByline: true },
            }),
        );
        if (!row?.baseUrl || !row.apiKeyCiphertext) return null;
        return {
            baseUrl: row.baseUrl,
            apiKey: this.secrets.open(row.apiKeyCiphertext),
            verify: row.verifyWithByline,
        };
    }
}
