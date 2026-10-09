import { randomBytes } from 'node:crypto';
import {
    ForbiddenException,
    GoneException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { MEMBER_DEFAULT_CAPABILITIES, SYSTEM_ROLES } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { RateLimited, UniqueConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { seedDefaultPipeline } from '../pipelines/seed';
import { INVITE_TTL_S, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_S, SLUG_SUFFIX_BYTES } from './auth.constants';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter.service';
import { hashToken, randomToken } from './tokens';
import type { UserView, WorkspaceView } from '../workspace/responses';
export type { UserView, WorkspaceView } from '../workspace/responses';

/** What an identity provider told us about the person who just signed in. */
export interface VerifiedIdentity {
    provider: string;
    subject: string;
    email: string;
}

type OwnerTx = Prisma.TransactionClient;

/**
 * The one trusted writer of the global tables (`users`, `workspaces`) and of the rows that make a
 * workspace usable (its two system roles, its first member). It writes through the **owner
 * client** because these rows exist before any tenant scope does — there is no workspace to be
 * inside of while creating the workspace — and because the app role is deliberately SELECT-only
 * on the global tables. Nothing else on a request path uses the owner client for writes; the
 * design note lists every reader.
 */
@Injectable()
export class AuthService {
    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly passwords: PasswordService,
        private readonly limiter: RateLimiter,
    ) {}

    /** Local sign-up: a user, their first workspace, and their admin seat, in one transaction. */
    async signup(input: {
        email: string;
        password: string;
        workspaceName: string;
    }): Promise<{ user: UserView; workspace: WorkspaceView }> {
        const email = normaliseEmail(input.email);
        const passwordHash = await this.passwords.hash(input.password);
        try {
            return await this.ownerPrisma.$transaction(async (tx) => {
                const user = await tx.user.create({ data: { email, passwordHash } });
                const workspace = await createWorkspaceWithAdmin(tx, user.id, input.workspaceName);
                return { user: userView(user), workspace };
            });
        } catch (error) {
            // The same message as a bad login: sign-up must not say whether an address is taken.
            throw uniqueViolation(error) ? new UniqueConflict('that sign-up cannot be completed') : error;
        }
    }

    /**
     * Local login. One generic failure for an unknown address, a provider-only account and a
     * wrong password alike; failures are counted per address and caller before the check, so
     * the limiter cannot be probed either.
     */
    async login(input: { email: string; password: string; ip: string }): Promise<UserView> {
        const email = normaliseEmail(input.email);
        const key = `login:${email}:${input.ip}`;
        if (await this.limiter.hit(key, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_S)) {
            throw new TooManyAttempts();
        }
        const user = await this.ownerPrisma.user.findUnique({ where: { email } });
        const ok = user?.passwordHash ? await this.passwords.verify(input.password, user.passwordHash) : false;
        if (!user || !ok) throw new UnauthorizedException('email or password is incorrect');
        await this.limiter.clear(key);
        return userView(user);
    }

    async me(userId: string): Promise<UserView> {
        const user = await this.ownerPrisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new UnauthorizedException();
        return userView(user);
    }

    /** A further workspace for an existing user; they become its admin. */
    createWorkspace(userId: string, name: string): Promise<WorkspaceView> {
        return this.ownerPrisma.$transaction((tx) => createWorkspaceWithAdmin(tx, userId, name));
    }

    /**
     * Sign-in through an identity provider. The provider's subject is the identity; the email
     * is how a first-time subject is matched to an existing account — and only a **verified**
     * email is, so a provider that vouches for nothing cannot claim someone else's address.
     */
    signInWithIdentity(identity: VerifiedIdentity): Promise<UserView> {
        const email = normaliseEmail(identity.email);
        return this.ownerPrisma.$transaction(async (tx) => {
            const known = await tx.externalIdentity.findUnique({
                where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
                include: { user: true },
            });
            if (known) return userView(known.user);
            const user =
                (await tx.user.findUnique({ where: { email } })) ??
                (await tx.user.create({ data: { email, emailVerifiedAt: new Date() } }));
            if (!user.emailVerifiedAt) {
                await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
            }
            await tx.externalIdentity.create({
                data: { userId: user.id, provider: identity.provider, subject: identity.subject, email },
            });
            return userView({ ...user, emailVerifiedAt: user.emailVerifiedAt ?? new Date() });
        });
    }

    /**
     * Accepting an invitation. The token proves the holder read the invited mailbox; the account
     * accepting must be that address, and that address must be verified — or the account is being
     * created right now from the invitation, which is itself the verification.
     */
    async acceptInvite(
        token: string,
        actor: { userId: string } | { signup: { password: string } },
    ): Promise<{ workspace: WorkspaceView; userId: string }> {
        const tokenHash = hashToken(token);
        const passwordHash = 'signup' in actor ? await this.passwords.hash(actor.signup.password) : null;
        return this.ownerPrisma.$transaction(async (tx) => {
            const invite = await tx.workspaceInvite.findUnique({ where: { tokenHash }, include: { workspace: true } });
            if (!invite) throw new NotFoundException('invitation not found');
            if (invite.acceptedAt) throw new GoneException('invitation already used');
            if (invite.expiresAt <= new Date()) throw new GoneException('invitation expired');

            let userId: string;
            if ('signup' in actor) {
                const created = await tx.user
                    .create({ data: { email: invite.email, passwordHash, emailVerifiedAt: new Date() } })
                    .catch((error: unknown) => {
                        throw uniqueViolation(error) ? new UniqueConflict('sign in to accept this invitation') : error;
                    });
                userId = created.id;
            } else {
                const user = await tx.user.findUnique({ where: { id: actor.userId } });
                if (!user || user.email !== invite.email)
                    throw new ForbiddenException('invitation is for a different address');
                if (!user.emailVerifiedAt) throw new ForbiddenException('verify your email address first');
                userId = user.id;
            }
            await tx.workspaceMember
                .create({
                    data: {
                        workspaceId: invite.workspaceId,
                        userId,
                        roleId: invite.roleId,
                        displayName: displayNameFor(invite.email),
                    },
                })
                .catch((error: unknown) => {
                    throw uniqueViolation(error) ? new UniqueConflict('already a member') : error;
                });
            await tx.workspaceInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
            return { workspace: workspaceView(invite.workspace), userId };
        });
    }

    /** The invite row, written by the workspace admin through RLS; this just makes the token. */
    static newInvite(): { token: string; tokenHash: string; expiresAt: Date } {
        const token = randomToken();
        return { token, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_S * 1000) };
    }
}

/** `429` with the message the login route sends. */
export class TooManyAttempts extends RateLimited {}

/** The one spelling of an email address the database ever sees. */
export function normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
}

async function createWorkspaceWithAdmin(tx: OwnerTx, userId: string, name: string): Promise<WorkspaceView> {
    const workspace = await tx.workspace.create({ data: { name: name.trim(), slug: slugFor(name) } });
    const admin = await tx.role.create({
        data: { workspaceId: workspace.id, name: SYSTEM_ROLES.admin, isSystem: true },
    });
    await tx.role.create({
        data: {
            workspaceId: workspace.id,
            name: SYSTEM_ROLES.member,
            isSystem: true,
            permissions: {
                create: MEMBER_DEFAULT_CAPABILITIES.map((capability) => ({ workspaceId: workspace.id, capability })),
            },
        },
    });
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId, roleId: admin.id, displayName: displayNameFor(user.email) },
    });
    // The pipeline deals go into (P1-2), from the one stage list; a workspace is not usable without it.
    await seedDefaultPipeline(tx, workspace.id);
    return workspaceView(workspace);
}

/**
 * The name a new member is shown under until they set one: the local part of their address.
 * Other members see this and never the address itself (`/members/summary`).
 */
export function displayNameFor(email: string): string {
    return email.split('@')[0] ?? email;
}

/** `acme-corp-3f9a1c`: readable, unique by its suffix, never a second query to check. */
function slugFor(name: string): string {
    const words = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return `${words || 'workspace'}-${randomBytes(SLUG_SUFFIX_BYTES).toString('hex')}`;
}

function userView(user: { id: string; email: string; emailVerifiedAt: Date | null }): UserView {
    return { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null };
}

export function workspaceView(workspace: { id: string; slug: string; name: string }): WorkspaceView {
    return { id: workspace.id, slug: workspace.slug, name: workspace.name };
}
