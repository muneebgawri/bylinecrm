import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { invitationUrl, type PlatformEvent, SYSTEM_ROLES } from '@bylinecrm/shared';
import { AuthService, normaliseEmail } from '../auth/auth.service';
import { hashToken, randomToken } from '../auth/tokens';
import { INVITE_TTL_S } from '../auth/auth.constants';
import { ENV, type Env } from '../config/env';
import { StateConflict } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { AccountMail } from '../transactional-mail/account-mail';
import { recordPlatformAction } from './audit';
import type { CreatedPlatformWorkspaceView, PlatformInviteView, PlatformWorkspaceView } from './responses';

/** The most workspaces one list returns; a platform runs tens, and the page says when it is cut. */
export const PLATFORM_WORKSPACE_LIST_LIMIT = 500;

/**
 * What a platform admin does (P0-14). Workspace creation goes through `AuthService`, the one
 * writer of `users` and `workspaces`; this service adds the platform's own rows — sign-up
 * invitations and the audit — and reads across workspaces for the list. All of it is owner-client
 * work by nature (there is no one workspace to be inside of), and the controller lets only a
 * platform admin reach it. Every action is audited in its transaction and published on the bus
 * after commit, as an operator-level event no workspace subscriber takes.
 */
@Injectable()
export class PlatformService {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly auth: AuthService,
        private readonly bus: EventEmitter2,
        private readonly mail: AccountMail,
    ) {}

    async listWorkspaces(): Promise<PlatformWorkspaceView[]> {
        const now = new Date();
        const workspaces = await this.ownerPrisma.workspace.findMany({
            orderBy: { createdAt: 'desc' },
            take: PLATFORM_WORKSPACE_LIST_LIMIT,
            select: {
                id: true,
                slug: true,
                name: true,
                createdAt: true,
                _count: { select: { members: true } },
                invites: {
                    where: {
                        acceptedAt: null,
                        expiresAt: { gt: now },
                        role: { isSystem: true, name: SYSTEM_ROLES.admin },
                    },
                    orderBy: { createdAt: 'asc' },
                    select: { email: true, expiresAt: true },
                },
            },
        });
        return workspaces.map((w) => ({
            id: w.id,
            slug: w.slug,
            name: w.name,
            createdAt: w.createdAt,
            memberCount: w._count.members,
            pendingInvites: w.invites,
        }));
    }

    async createWorkspace(
        actorUserId: string,
        input: { name: string; ownerEmail: string },
    ): Promise<CreatedPlatformWorkspaceView> {
        const { workspace, invite, event } = await this.auth.createWorkspaceForOwner({ actorUserId, ...input });
        this.publish(event);
        return { workspace, invite };
    }

    /**
     * A sign-up invitation (`invite` mode): lets one address create an account and a workspace of
     * its own. Pointless in the other modes — `closed` takes no sign-ups and `open` needs no
     * invitation — so it is refused there rather than handed out to do nothing.
     */
    async createSignupInvite(actorUserId: string, rawEmail: string): Promise<PlatformInviteView> {
        if (this.env.SIGNUP_MODE !== 'invite') {
            throw new StateConflict('sign-up invitations are used only when SIGNUP_MODE is invite');
        }
        const email = normaliseEmail(rawEmail);
        const token = randomToken();
        const expiresAt = new Date(Date.now() + INVITE_TTL_S * 1000);
        const { inviteId, event } = await this.ownerPrisma.$transaction(async (tx) => {
            const invite = await tx.platformSignupInvite.create({
                data: { email, tokenHash: hashToken(token), createdByUserId: actorUserId, expiresAt },
                select: { id: true },
            });
            const audited = await recordPlatformAction(tx, 'platform.signup_invite_created', actorUserId, { email });
            return { inviteId: invite.id, event: audited };
        });
        this.publish(event);
        // Mailed after commit (#93); the link is also returned once, to pass on by hand.
        await this.mail.signupInvitation({ to: email, inviteId, token });
        return { email, token, url: invitationUrl(this.env.WEB_URL, 'signup', token), expiresAt };
    }

    private publish(event: PlatformEvent): void {
        this.bus.emit(event.type, event);
    }
}
