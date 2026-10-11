import { randomBytes } from 'node:crypto';
import {
    ForbiddenException,
    GoneException,
    Inject,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { invitationUrl, MEMBER_DEFAULT_CAPABILITIES, SYSTEM_ROLES } from '@bylinecrm/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { ApiException, RateLimited, UniqueConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { seedDefaultPipeline } from '../pipelines/seed';
import { recordPlatformAction } from '../platform/audit';
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
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly passwords: PasswordService,
        private readonly limiter: RateLimiter,
    ) {}

    /**
     * Local sign-up: a user, their first workspace, and their admin seat, in one transaction —
     * when `SIGNUP_MODE` allows it (P0-14). `closed` refuses every sign-up; `invite` needs a
     * platform sign-up invitation for this address; `open` takes anyone. A sign-up invitation, when
     * one is presented, is spent here and verifies the address (the holder read that mailbox).
     */
    async signup(input: {
        email: string;
        password: string;
        workspaceName: string;
        inviteToken?: string | undefined;
    }): Promise<{ user: UserView; workspace: WorkspaceView }> {
        const mode = this.env.SIGNUP_MODE;
        if (mode === 'closed') throw new SignupClosed();
        if (mode === 'invite' && !input.inviteToken) throw new SignupInvitationRequired();
        const email = normaliseEmail(input.email);
        const passwordHash = await this.passwords.hash(input.password);
        try {
            return await this.ownerPrisma.$transaction(async (tx) => {
                const verified = input.inviteToken ? await spendSignupInvite(tx, input.inviteToken, email) : false;
                const user = await tx.user.create({
                    data: {
                        email,
                        passwordHash,
                        displayName: displayNameFor(email),
                        emailVerifiedAt: verified ? new Date() : null,
                    },
                });
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
     * A workspace a platform admin creates for someone else (P0-14): the workspace, its system
     * roles and pipeline, no member yet, and an invitation to its admin role for `ownerEmail`. The
     * owner accepts with their account if they have one (signed in, address verified) or signs up
     * through the invitation, which works in every sign-up mode. The audit row is written in the
     * same transaction.
     */
    async createWorkspaceForOwner(input: { actorUserId: string; name: string; ownerEmail: string }): Promise<{
        workspace: WorkspaceView;
        invite: CreatedPlatformInvite;
    }> {
        const email = normaliseEmail(input.ownerEmail);
        const { token, tokenHash, expiresAt } = AuthService.newInvite();
        return this.ownerPrisma.$transaction(async (tx) => {
            const { workspace, adminRoleId } = await createWorkspaceShell(tx, input.name);
            await tx.workspaceInvite.create({
                data: {
                    workspaceId: workspace.id,
                    email,
                    roleId: adminRoleId,
                    tokenHash,
                    invitedByUserId: input.actorUserId,
                    expiresAt,
                },
            });
            await recordPlatformAction(tx, 'platform.workspace_created', input.actorUserId, {
                workspaceId: workspace.id,
                email,
            });
            const url = invitationUrl(this.env.WEB_URL, 'member', token);
            return { workspace, invite: { email, token, url, expiresAt } };
        });
    }

    /**
     * The public face of a workspace invitation, for the page that accepts it: the address it is
     * for and the workspace's name. Only someone holding the token can ask; an unknown, spent or
     * expired token answers the same way accepting it would.
     */
    async previewInvite(token: string): Promise<{ email: string; workspaceName: string; expiresAt: Date }> {
        const invite = await this.ownerPrisma.workspaceInvite.findUnique({
            where: { tokenHash: hashToken(token) },
            select: { email: true, expiresAt: true, acceptedAt: true, workspace: { select: { name: true } } },
        });
        if (!invite) throw new NotFoundException('invitation not found');
        if (invite.acceptedAt) throw new GoneException('invitation already used');
        if (invite.expiresAt <= new Date()) throw new GoneException('invitation expired');
        return { email: invite.email, workspaceName: invite.workspace.name, expiresAt: invite.expiresAt };
    }

    /**
     * Sign-in through an identity provider. The provider's subject is the identity; the email
     * is how a first-time subject is matched to an existing account — and only a **verified**
     * email is, so a provider that vouches for nothing cannot claim someone else's address. An
     * address with no account gets one only when sign-up is open or it was let in (P0-14); otherwise
     * `403 signup.closed`, and nothing is written.
     */
    signInWithIdentity(identity: VerifiedIdentity): Promise<UserView> {
        const email = normaliseEmail(identity.email);
        return this.ownerPrisma.$transaction(async (tx) => {
            const known = await tx.externalIdentity.findUnique({
                where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
                include: { user: true },
            });
            if (known) return userView(known.user);
            let user = await tx.user.findUnique({ where: { email } });
            if (!user) {
                // Outside open mode a provider sign-in is not a back door to sign-up (P0-14): only an
                // address someone has let in gets an account. Same answer as the password path.
                if (this.env.SIGNUP_MODE !== 'open' && !(await this.mayCreateAccount(tx, email))) {
                    throw new SignupClosed();
                }
                user = await tx.user.create({
                    data: { email, emailVerifiedAt: new Date(), displayName: displayNameFor(email) },
                });
            }
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
     * Whether an address with no account may get one when sign-up is not open: it is a platform
     * admin's, or a pending, unexpired invitation names it — to a workspace, or to sign up.
     */
    private async mayCreateAccount(tx: OwnerTx, email: string): Promise<boolean> {
        if (this.env.PLATFORM_ADMIN_EMAILS.includes(email)) return true;
        const pending = { email, expiresAt: { gt: new Date() } };
        if ((await tx.workspaceInvite.count({ where: { ...pending, acceptedAt: null } })) > 0) return true;
        return (await tx.platformSignupInvite.count({ where: { ...pending, usedAt: null } })) > 0;
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
                    .create({
                        data: {
                            email: invite.email,
                            passwordHash,
                            emailVerifiedAt: new Date(),
                            displayName: displayNameFor(invite.email),
                        },
                    })
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
                    data: { workspaceId: invite.workspaceId, userId, roleId: invite.roleId },
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

/** A workspace invitation a platform admin made: the token and link are shown once. */
export interface CreatedPlatformInvite {
    email: string;
    token: string;
    url: string;
    expiresAt: Date;
}

/** `403 signup.closed`: this deployment takes no sign-ups (`SIGNUP_MODE=closed`). */
export class SignupClosed extends ApiException {
    constructor() {
        super(403, 'signup.closed', 'sign-ups are closed; ask your administrator for an invitation');
    }
}

/** `403 signup.invitation_required`: sign-up needs a valid sign-up invitation for this address. */
export class SignupInvitationRequired extends ApiException {
    constructor() {
        super(403, 'signup.invitation_required', 'sign-up needs a valid invitation for this address');
    }
}

/**
 * Spends a platform sign-up invitation for `email`, or refuses. Unknown, expired, spent and
 * someone-else's tokens all get the same answer. The conditional update makes a token good for
 * exactly one sign-up even when two race.
 */
async function spendSignupInvite(tx: OwnerTx, token: string, email: string): Promise<true> {
    const spent = await tx.platformSignupInvite.updateMany({
        where: { tokenHash: hashToken(token), email, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
    });
    if (spent.count !== 1) throw new SignupInvitationRequired();
    return true;
}

/**
 * The operator's bootstrap for a platform admin's address (P0-14), run on the server by
 * `cli/platform-verify-email`: marks the account's address verified, which today nothing else
 * does for a password account that was not created from an invitation. It refuses an address
 * that is not in `PLATFORM_ADMIN_EMAILS`, so it cannot be used to verify anyone else, and records
 * the act (actor `null`: an operator command, not a signed-in person). The email-verification
 * card replaces it with a mailed link.
 */
export async function verifyPlatformAdminEmail(
    owner: PrismaClient,
    env: Pick<Env, 'PLATFORM_ADMIN_EMAILS'>,
    rawEmail: string,
): Promise<{ email: string; alreadyVerified: boolean }> {
    const email = normaliseEmail(rawEmail);
    if (!env.PLATFORM_ADMIN_EMAILS.includes(email)) {
        throw new Error(
            `${email} is not in PLATFORM_ADMIN_EMAILS; only a platform admin's address is verified this way`,
        );
    }
    return owner.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { email } });
        if (!user) throw new Error(`no account for ${email}; sign up (or accept an invitation) first`);
        if (user.emailVerifiedAt) return { email, alreadyVerified: true };
        await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
        await recordPlatformAction(tx, 'platform.admin_email_verified', null, { email });
        return { email, alreadyVerified: false };
    });
}

/**
 * A workspace with everything that makes it usable except a member: its two system roles and
 * its pipeline (P1-2), the latter from the one stage list.
 */
async function createWorkspaceShell(
    tx: OwnerTx,
    name: string,
): Promise<{ workspace: WorkspaceView; adminRoleId: string }> {
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
    // The pipeline deals go into (P1-2), from the one stage list; a workspace is not usable without it.
    await seedDefaultPipeline(tx, workspace.id);
    return { workspace: workspaceView(workspace), adminRoleId: admin.id };
}

async function createWorkspaceWithAdmin(tx: OwnerTx, userId: string, name: string): Promise<WorkspaceView> {
    const { workspace, adminRoleId } = await createWorkspaceShell(tx, name);
    await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId, roleId: adminRoleId } });
    return workspace;
}

/**
 * The name a new person is shown under until they confirm one (`/api/me/profile`): the local part
 * of their address. Other members see this and never the address itself (`/members/summary`).
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
