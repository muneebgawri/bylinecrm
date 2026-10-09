import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from '../auth/auth.service';
import { Requires } from '../auth/decorators';
import { CreateApiKeyDto, CreateInviteDto, CreateRoleDto, SetMemberRoleDto, UpdateRoleDto } from '../auth/dto';
import { ApiKeyService, type ApiKeyView } from '../auth/api-key.service';
import { normaliseEmail } from '../auth/auth.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { MembersService, type MemberView } from './members.service';
import { RolesService, type RoleView } from './roles.service';

/**
 * Workspace administration. Every route is under `/api/w/:workspaceId`, so the workspace guard
 * has already decided the caller belongs here; `@Requires` says what they must be allowed to do.
 * The services read the workspace from `WorkspaceContext`, never from the URL.
 */
@ApiTags('workspace')
@Controller('w/:workspaceId/members')
export class MembersController {
    constructor(private readonly members: MembersService) {}

    @Requires('workspace:admin')
    @Get()
    list(): Promise<MemberView[]> {
        return this.members.list();
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
@Controller('w/:workspaceId/roles')
export class RolesController {
    constructor(private readonly roles: RolesService) {}

    /** Any member may see the roles (the UI needs names); only an admin changes them. */
    @Requires('record:read')
    @Get()
    list(): Promise<RoleView[]> {
        return this.roles.list();
    }

    @Requires('workspace:admin')
    @Post()
    create(@Body() body: CreateRoleDto): Promise<RoleView> {
        return this.roles.create(body.name, body.capabilities);
    }

    @Requires('workspace:admin')
    @Patch(':roleId')
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
@Controller('w/:workspaceId/api-keys')
export class ApiKeysController {
    constructor(
        private readonly apiKeys: ApiKeyService,
        private readonly context: WorkspaceContext,
    ) {}

    @Requires('workspace:admin')
    @Get()
    list(): Promise<ApiKeyView[]> {
        return this.apiKeys.list();
    }

    /** The response carries the full key once; it is not stored and cannot be shown again. */
    @Requires('workspace:admin')
    @Post()
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

export interface InviteView {
    id: string;
    email: string;
    roleId: string;
    expiresAt: Date;
    acceptedAt: Date | null;
}

@ApiTags('workspace')
@Controller('w/:workspaceId/invites')
export class InvitesController {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    @Requires('workspace:admin')
    @Get()
    list(): Promise<InviteView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const invites = await tx.workspaceInvite.findMany({ orderBy: { createdAt: 'asc' } });
            return invites.map(inviteView);
        });
    }

    /**
     * The token is returned once so the admin (or, later, the invitation email) can hand it to
     * the invitee; only its hash is stored. Sending the email is not built here.
     */
    @Requires('workspace:admin')
    @Post()
    create(@Body() body: CreateInviteDto): Promise<{ invite: InviteView; token: string }> {
        const current = this.context.get();
        if (!current?.memberId) throw new Error('invitations are sent by a member, not by a key');
        const { token, tokenHash, expiresAt } = AuthService.newInvite();
        return this.rls.withWorkspace(async (tx) => {
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
