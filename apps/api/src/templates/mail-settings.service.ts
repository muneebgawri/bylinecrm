import { Injectable } from '@nestjs/common';
import { DEFAULT_UNSUBSCRIBE_FOOTER_TEXT, type MailSettings, type PostalAddress } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import type { MailSettingsView } from './responses';

/**
 * The workspace's mail settings (P2-4): the postal address outreach mail must carry, the default
 * sender name, and the unsubscribe notice. One row per workspace, absent until first saved — a
 * workspace that never saved them reads the defaults, and so does every render.
 */
@Injectable()
export class MailSettingsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    get(): Promise<MailSettingsView> {
        this.current();
        return this.rls.withWorkspace((tx) => readMailSettings(tx));
    }

    /** Replaces the settings as a whole. */
    async put(input: MailSettings): Promise<MailSettingsView> {
        const context = this.current();
        const data = {
            // A JSON column's SQL NULL is `DbNull`; a plain `null` would be refused.
            postalAddress: input.postalAddress
                ? (input.postalAddress as unknown as Prisma.InputJsonObject)
                : Prisma.DbNull,
            defaultSenderName: input.defaultSenderName,
            unsubscribeFooterText: input.unsubscribeFooterText,
            updatedBy: actorOf(context) as Prisma.InputJsonObject,
        };
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.workspaceMailSettings.upsert({
                where: { workspaceId: context.workspaceId },
                create: { workspaceId: context.workspaceId, ...data },
                update: data,
            });
            return viewOf(row);
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('MailSettingsService is used inside a workspace scope');
        return context;
    }
}

type SettingsRow = Prisma.WorkspaceMailSettingsGetPayload<object>;

function viewOf(row: SettingsRow | null): MailSettingsView {
    if (!row)
        return { postalAddress: null, defaultSenderName: null, unsubscribeFooterText: DEFAULT_UNSUBSCRIBE_FOOTER_TEXT };
    return {
        postalAddress: (row.postalAddress as PostalAddress | null) ?? null,
        defaultSenderName: row.defaultSenderName,
        unsubscribeFooterText: row.unsubscribeFooterText,
    };
}

/** The current workspace's settings inside an open transaction — what a render reads. */
export async function readMailSettings(tx: WorkspaceClient): Promise<MailSettingsView> {
    return viewOf(await tx.workspaceMailSettings.findFirst());
}
