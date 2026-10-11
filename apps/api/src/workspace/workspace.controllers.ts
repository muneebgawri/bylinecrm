import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from '../auth/auth.service';
import { AnyMember, Requires, TenantController } from '../auth/decorators';
import { CreateApiKeyDto, CreateInviteDto, CreateRoleDto, SetMemberRoleDto, UpdateRoleDto } from '../auth/dto';
import { ApiKeyService, type ApiKeyView } from '../auth/api-key.service';
import { normaliseEmail } from '../auth/auth.service';
import { UnknownReference } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { AccountMail } from '../transactional-mail/account-mail';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { MembersService, type MemberSummaryView, type MemberView } from './members.service';
import { RolesService, type RoleView } from './roles.service';
import type { StandingView, InviteView } from './responses';
import { Returns } from '../openapi/responses';
import {
    apiKeyView,
    createdApiKey,
    createdInvite,
    inviteView as inviteSchema,
    memberSummaryView,
    memberView,
    roleView,
    standingView,
} from './responses';
export type { StandingView, InviteView } from './responses';

/** One source: the guard's decision in `WorkspaceContext`; nothing is computed a second time. */
export function standingOf(context: WorkspaceRunContext): StandingView {
    return {
        workspaceId: context.workspaceId,
        memberId: context.memberId ?? null,
        userId: context.userId ?? null,
        apiKeyId: context.apiKeyId ?? null,
        roleId: context.roleId ?? null,
        roleName: context.roleName ?? null,
        recordScope: context.ownerScopeMemberId ? 'own' : 'all',
        capabilities: [...context.capabilities],
    };
}

@ApiTags('workspace')
@TenantController('me')
export class WorkspaceMeController {
    constructor(private readonly context: WorkspaceContext) {}

    /** The UI reads this to show or hide controls (FR-CRMS-UI-6); the server stays the gate. */
    @AnyMember('a caller asking what they may do cannot be asked for a capability first')
    @Get()
    @Returns(standingView)
    standing(): StandingView {
        const current = this.context.get();
        if (!current) throw new Error('standing is read inside a workspace scope');
        return standingOf(current);
    }
}

/**
 * Workspace administration. Every route is under `/api/w/:workspaceId`, so the workspace guard
 * has already decided the caller belongs here; `@Requires` says what they must be allowed to do.
 * The services read the workspace from `WorkspaceContext`, never from the URL.
 */
@ApiTags('workspace')
@TenantController('members')
export class MembersController {
    constructor(private readonly members: MembersService) {}

    @Requires('workspace:admin')
    @Get()
    @Returns([memberView])
    list(): Promise<MemberView[]> {
        return this.members.list();
    }

    /** Declared before `:memberId` so the literal segment wins. */
    @Requires('record:read')
    @Get('summary')
    @Returns([memberSummaryView])
    summary(): Promise<MemberSummaryView[]> {
        return this.members.summary();
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Patch(':memberId/role')
    setRole(@Param('memberId', ParseUUIDPipe) memberId: string, @Body() body: SetMemberRoleDto): Promise<void> {
        return this.members.setRole(memberId, body.roleId);
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete(':memberId')
    remove(@Param('memberId', ParseUUIDPipe) memberId: string): Promise<void> {
        return this.members.remove(memberId);
    }
}

@ApiTags('workspace')
@TenantController('roles')
export class RolesController {
    constructor(private readonly roles: RolesService) {}

    /** Any member may see the roles (the UI needs names); only an admin changes them. */
    @Requires('record:read')
    @Get()
    @Returns([roleView])
    list(): Promise<RoleView[]> {
        return this.roles.list();
    }

    @Requires('workspace:admin')
    @Post()
    @Returns(roleView)
    create(@Body() body: CreateRoleDto): Promise<RoleView> {
        return this.roles.create(body.name, body.capabilities, body.recordScope);
    }

    @Requires('workspace:admin')
    @Patch(':roleId')
    @Returns(roleView)
    update(@Param('roleId', ParseUUIDPipe) roleId: string, @Body() body: UpdateRoleDto): Promise<RoleView> {
        return this.roles.update(roleId, body);
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete(':roleId')
    remove(@Param('roleId', ParseUUIDPipe) roleId: string): Promise<void> {
        return this.roles.remove(roleId);
    }
}

@ApiTags('workspace')
@TenantController('api-keys')
export class ApiKeysController {
    constructor(
        private readonly apiKeys: ApiKeyService,
        private readonly context: WorkspaceContext,
    ) {}

    @Requires('workspace:admin')
    @Get()
    @Returns([apiKeyView])
    list(): Promise<ApiKeyView[]> {
        return this.apiKeys.list();
    }

    /** The response carries the full key once; it is not stored and cannot be shown again. */
    @Requires('workspace:admin')
    @Post()
    @Returns(createdApiKey)
    create(@Body() body: CreateApiKeyDto): Promise<{ key: ApiKeyView; secret: string }> {
        const memberId = this.context.get()?.memberId;
        if (!memberId) throw new Error('API keys are created by a member, not by another key');
        return this.apiKeys.create({ ...body, createdById: memberId });
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete(':apiKeyId')
    revoke(@Param('apiKeyId', ParseUUIDPipe) apiKeyId: string): Promise<void> {
        return this.apiKeys.revoke(apiKeyId);
    }
}

@ApiTags('workspace')
@TenantController('invites')
export class InvitesController {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly mail: AccountMail,
    ) {}

    @Requires('workspace:admin')
    @Get()
    @Returns([inviteSchema])
    list(): Promise<InviteView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const invites = await tx.workspaceInvite.findMany({ orderBy: { createdAt: 'asc' } });
            return invites.map(inviteView);
        });
    }

    /**
     * The invitation is mailed to the invitee — recorded in the same transaction, sent after the
     * commit (#93) — and the token is also returned once so the admin can pass the link on by hand;
     * only its hash is stored.
     */
    @Requires('workspace:admin')
    @Post()
    @Returns(createdInvite)
    create(@Body() body: CreateInviteDto): Promise<{ invite: InviteView; token: string }> {
        const current = this.context.get();
        if (!current?.memberId) throw new Error('invitations are sent by a member, not by a key');
        const { token, tokenHash, expiresAt } = AuthService.newInvite();
        return this.rls.withWorkspace(async (tx) => {
            // Looked up inside the workspace: the foreign key alone would accept another workspace's role.
            const role = await tx.role.findUnique({ where: { id: body.roleId }, select: { id: true } });
            if (!role) throw new UnknownReference('roleId', 'no such role in this workspace');
            const invite = await tx.workspaceInvite.create({
                data: {
                    workspaceId: current.workspaceId,
                    email: normaliseEmail(body.email),
                    roleId: body.roleId,
                    tokenHash,
                    invitedById: current.memberId!,
                    expiresAt,
                },
            });
            const workspace = await tx.workspace.findUniqueOrThrow({
                where: { id: current.workspaceId },
                select: { name: true },
            });
            await this.mail.workspaceInvitation(tx, {
                workspaceId: current.workspaceId,
                to: invite.email,
                inviteId: invite.id,
                token,
                workspaceName: workspace.name,
                owner: false,
            });
            return { invite: inviteView(invite), token };
        });
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete(':inviteId')
    revoke(@Param('inviteId', ParseUUIDPipe) inviteId: string): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            await tx.workspaceInvite.delete({ where: { id: inviteId } });
        });
    }
}

function inviteView(invite: {
    id: string;
    email: string;
    roleId: string;
    expiresAt: Date;
    acceptedAt: Date | null;
}): InviteView {
    return {
        id: invite.id,
        email: invite.email,
        roleId: invite.roleId,
        expiresAt: invite.expiresAt,
        acceptedAt: invite.acceptedAt,
    };
}
