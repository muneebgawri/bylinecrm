import { Injectable, NotFoundException } from '@nestjs/common';
import type {
    MailboxPreference,
    RotationMemberView,
    RotationPreviewView,
    RotationSettingsView,
} from '@bylinecrm/shared';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { CadenceService } from './cadence.service';
import { eligible } from './rotation-picker';
import { RotationService, settingsView } from './rotation.service';

export interface RotationSettingsInput {
    enabled: boolean;
    warnAfterDays: number;
    graceDays: number;
    intakeEnabled: boolean;
    mailboxPreference: MailboxPreference;
    openLeadCap: number | null;
}

export interface RotationMemberPatch {
    included?: boolean | null | undefined;
    paused?: boolean | undefined;
    resumeAt?: string | null | undefined;
    weight?: number | undefined;
}

/** Settings → Rotation (CADENCE-1): the settings, who is in the rotation, and the dry run. `pipeline:cadence`. */
@Injectable()
export class RotationSettingsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly rotation: RotationService,
        private readonly cadence: CadenceService,
    ) {}

    get(): Promise<RotationSettingsView> {
        return this.rls.withWorkspace(async (tx) => settingsView(await this.rotation.settings(tx)));
    }

    /**
     * Switching rotation on stamps `enabledAt` (the grace start: lapses are measured from it, so an existing backlog
     * is warned from now and never rotated at once); switching it off ends every open lapse.
     */
    set(input: RotationSettingsInput): Promise<RotationSettingsView> {
        const { workspaceId } = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const before = await this.rotation.settings(tx);
            const now = new Date();
            const enabledAt = input.enabled ? (before.enabled && before.enabledAt ? before.enabledAt : now) : null;
            const row = await tx.rotationSettings.upsert({
                where: { workspaceId },
                create: { workspaceId, ...input, enabledAt },
                update: { ...input, enabledAt },
            });
            if (!input.enabled && before.enabled) {
                await tx.cadenceLapse.updateMany({
                    where: { resolvedAt: null },
                    data: { resolvedAt: now, resolution: 'out_of_scope' },
                });
            }
            return settingsView(row);
        });
    }

    members(): Promise<RotationMemberView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const settings = await this.rotation.settings(tx);
            const candidates = await this.rotation.candidates(tx);
            const now = new Date();
            const dealt = new Set(eligible(candidates, settings, now).map((c) => c.memberId));
            return candidates.map((c) => ({
                memberId: c.memberId,
                name: c.name,
                email: c.email,
                roleName: c.roleName,
                included: c.included,
                includedByDefault: c.includedByDefault,
                paused: c.paused && (c.resumeAt === null || c.resumeAt > now),
                resumeAt: c.resumeAt?.toISOString() ?? null,
                weight: c.weight,
                hasMailbox: c.hasMailbox,
                openLeads: c.openLeads,
                eligible: dealt.has(c.memberId),
            }));
        });
    }

    async setMember(memberId: string, patch: RotationMemberPatch): Promise<RotationMemberView> {
        const { workspaceId } = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const member = await tx.workspaceMember.findFirst({
                where: { id: memberId, leftAt: null },
                select: { id: true },
            });
            if (!member) throw new NotFoundException('member not found');
            // A resume date is a pause's: setting one pauses.
            const paused = patch.paused ?? (patch.resumeAt ? true : undefined);
            const data = {
                ...(patch.included !== undefined ? { included: patch.included } : {}),
                ...(paused !== undefined ? { paused, ...(paused ? {} : { resumeAt: null }) } : {}),
                ...(patch.resumeAt !== undefined && paused !== false
                    ? { resumeAt: patch.resumeAt === null ? null : new Date(patch.resumeAt) }
                    : {}),
                ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
            };
            await tx.rotationMember.upsert({
                where: { memberId },
                create: { workspaceId, memberId, ...data },
                update: data,
            });
        });
        const view = (await this.members()).find((m) => m.memberId === memberId);
        if (!view) throw new NotFoundException('member not found');
        return view;
    }

    preview(): Promise<RotationPreviewView> {
        return this.cadence.preview(this.current().workspaceId);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('RotationSettingsService is used inside a workspace scope');
        return context;
    }
}
