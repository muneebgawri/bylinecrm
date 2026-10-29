import { randomBytes } from 'node:crypto';
import {
    ForbiddenException,
    GoneException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import {
    invitationUrl,
    mailedLinkUrl,
    MANAGER_DEFAULT_CAPABILITIES,
    MEMBER_DEFAULT_CAPABILITIES,
    RESET_PASSWORD_PAGE,
    SYSTEM_ROLES,
} from '@bylinecrm/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { ApiException, RateLimited, UniqueConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { seedDefaultPipeline } from '../pipelines/seed';
import { recordPlatformAction } from '../platform/audit';
import { AccountMail } from '../transactional-mail/account-mail';
import {
    INVITE_TTL_S,
    LOGIN_MAX_ATTEMPTS,
    LOGIN_WINDOW_S,
    RESET_REQUEST_ADDRESS_MAX,
    RESET_REQUEST_IP_MAX,
    RESET_REQUEST_MAX,
    RESET_REQUEST_WINDOW_S,
    SLUG_SUFFIX_BYTES,
    VERIFY_RESEND_MAX,
    VERIFY_RESEND_WINDOW_S,
} from './auth.constants';
import { InvalidToken, OneTimeTokenService } from './one-time-token.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter.service';
import { revokeAllSessions } from './session.service';
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
    private readonly logger = new Logger(AuthService.name);

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly passwords: PasswordService,
        private readonly limiter: RateLimiter,
        private readonly links: OneTimeTokenService,
        private readonly mail: AccountMail,
    ) {}

    /**
     * Local sign-up: a user, their first workspace, and their admin seat, in one transaction —
     * when `SIGNUP_MODE` allows it (P0-14). `closed` refuses every sign-up; `invite` needs a
     * platform sign-up invitation for this address, spent here; `open` takes anyone. The account
     * starts unverified and is mailed a verification link, recorded in the same transaction (#93): an invitation
     * link was also shown to whoever created it, so holding it proves nothing about the mailbox.
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
        let created: { user: UserView; workspace: WorkspaceView };
        try {
            created = await this.ownerPrisma.$transaction(async (tx) => {
                if (input.inviteToken) await spendSignupInvite(tx, input.inviteToken, email);
                const user = await tx.user.create({
                    data: { email, passwordHash, displayName: displayNameFor(email) },
                });
                const workspace = await createWorkspaceWithAdmin(tx, user.id, input.workspaceName);
                const link = await this.links.issue(tx, 'email_verification', user.id, email);
                await this.mail.verification(tx, email, link);
                return { user: userView(user), workspace };
            });
        } catch (error) {
            // The same message as a bad login: sign-up must not say whether an address is taken.
            throw uniqueViolation(error) ? new UniqueConflict('that sign-up cannot be completed') : error;
        }
        this.mail.kick();
        return created;
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

    /** A further workspace for an existing user, whose address is verified (#93); they become its admin. */
    createWorkspace(userId: string, name: string): Promise<WorkspaceView> {
        return this.ownerPrisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
            if (!user?.emailVerifiedAt) throw new EmailUnverified();
            return createWorkspaceWithAdmin(tx, userId, name);
        });
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
        const created = await this.ownerPrisma.$transaction(async (tx) => {
            const { workspace, adminRoleId } = await createWorkspaceShell(tx, input.name);
            const invite = await tx.workspaceInvite.create({
                data: {
                    workspaceId: workspace.id,
                    email,
                    roleId: adminRoleId,
                    tokenHash,
                    invitedByUserId: input.actorUserId,
                    expiresAt,
                },
                select: { id: true },
            });
            await recordPlatformAction(tx, 'platform.workspace_created', input.actorUserId, {
                workspaceId: workspace.id,
                email,
            });
            const url = invitationUrl(this.env.WEB_URL, 'member', token);
            await this.mail.workspaceInvitation(tx, {
                workspaceId: workspace.id,
                to: email,
                inviteId: invite.id,
                token,
                workspaceName: workspace.name,
                owner: true,
            });
            return { workspace, invite: { email, token, url, expiresAt } };
        });
        // Mailed (#93), and the link returned once to pass on by hand.
        this.mail.kick();
        return created;
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
     * Accepting an invitation, as the signed-in account or by creating one from it. The signed-in
     * account must be the invited address, verified. An account created from the invitation starts
     * unverified and is mailed a verification link, recorded in the same transaction (#93): the inviter was shown
     * the same link, so holding it does not prove the holder reads the mailbox.
     */
    async acceptInvite(
        token: string,
        actor: { userId: string } | { signup: { password: string } },
    ): Promise<{ workspace: WorkspaceView; userId: string }> {
        const tokenHash = hashToken(token);
        const passwordHash = 'signup' in actor ? await this.passwords.hash(actor.signup.password) : null;
        const accepted = await this.ownerPrisma.$transaction(async (tx) => {
            const invite = await tx.workspaceInvite.findUnique({ where: { tokenHash }, include: { workspace: true } });
            if (!invite) throw new NotFoundException('invitation not found');
            if (invite.acceptedAt) throw new GoneException('invitation already used');
            if (invite.expiresAt <= new Date()) throw new GoneException('invitation expired');

            let userId: string;
            // An account with no credential yet (the importer made it, #184) takes the invitation's password
            // and keeps the seat it already has: the invitation is how such an account comes to sign in.
            let claimed = false;
            if ('signup' in actor) {
                const existing = await tx.user.findUnique({
                    where: { email: invite.email },
                    include: { identities: { select: { id: true }, take: 1 } },
                });
                if (existing) {
                    if (existing.passwordHash || existing.identities.length > 0) {
                        throw new UniqueConflict('sign in to accept this invitation');
                    }
                    await tx.user.update({ where: { id: existing.id }, data: { passwordHash } });
                    userId = existing.id;
                    claimed = true;
                } else {
                    const created = await tx.user.create({
                        data: { email: invite.email, passwordHash, displayName: displayNameFor(invite.email) },
                    });
                    userId = created.id;
                }
                const link = await this.links.issue(tx, 'email_verification', userId, invite.email);
                await this.mail.verification(tx, invite.email, link);
            } else {
                const user = await tx.user.findUnique({ where: { id: actor.userId } });
                if (!user || user.email !== invite.email)
                    throw new ForbiddenException('invitation is for a different address');
                if (!user.emailVerifiedAt) throw new EmailUnverified();
                userId = user.id;
            }
            const seat = await takeSeat(tx, {
                workspaceId: invite.workspaceId,
                userId,
                roleId: invite.roleId,
                source: 'invite',
            });
            if (seat.held && !claimed) throw new UniqueConflict('already a member');
            await tx.workspaceInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
            return { workspace: workspaceView(invite.workspace), userId };
        });
        this.mail.kick();
        return accepted;
    }

    /**
     * An account and a seat for someone who is not here yet, made by the Twenty importer (#184) so the
     * records they own are theirs: the user if absent — no password, unverified; a Google sign-in with
     * the address or an invitation an admin sends later gives it a credential — and the seat with the
     * role the admin chose, marked `twenty-import`. A seat they left (#147) comes back as the same seat;
     * one still held is left as it is. Nothing is mailed. `leftAt` makes the seat a removed one from the
     * start: a member deactivated in Twenty who still owns records (history attributed, no access).
     */
    async provisionMember(input: {
        workspaceId: string;
        email: string;
        displayName: string | null;
        roleId: string;
        leftAt?: Date | null;
    }): Promise<{ userId: string; memberId: string; createdUser: boolean; createdSeat: boolean }> {
        const email = normaliseEmail(input.email);
        return this.ownerPrisma.$transaction(async (tx) => {
            let user = await tx.user.findUnique({ where: { email } });
            let createdUser = false;
            if (!user) {
                user = await tx.user.create({
                    data: { email, displayName: input.displayName?.trim() || displayNameFor(email) },
                });
                createdUser = true;
            }
            const seat = await takeSeat(tx, {
                workspaceId: input.workspaceId,
                userId: user.id,
                roleId: input.roleId,
                source: 'twenty-import',
                leftAt: input.leftAt ?? null,
            });
            return { userId: user.id, memberId: seat.memberId, createdUser, createdSeat: seat.created };
        });
    }

    /**
     * A fresh verification link for a signed-in, unverified account (#93); the previous one stops
     * working. Nothing is sent when the address is already verified. At most `VERIFY_RESEND_MAX`
     * per window per account, then `429`.
     */
    async requestVerification(userId: string): Promise<void> {
        if (await this.limiter.hit(`verify-resend:${userId}`, VERIFY_RESEND_MAX, VERIFY_RESEND_WINDOW_S)) {
            throw new TooManyAttempts('too many verification emails; try again later');
        }
        await this.ownerPrisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({ where: { id: userId } });
            if (!user) throw new UnauthorizedException();
            if (user.emailVerifiedAt) return;
            const link = await this.links.issue(tx, 'email_verification', user.id, user.email);
            await this.mail.verification(tx, user.email, link);
        });
        this.mail.kick();
    }

    /**
     * Spends a verification link (#93). It verifies only the address it was mailed to: if the
     * account's address changed since, the link is refused like any other bad link.
     */
    async verifyEmail(token: string): Promise<void> {
        await this.ownerPrisma.$transaction(async (tx) => {
            const spent = await this.links.spend(tx, 'email_verification', token);
            const user = await tx.user.findUnique({ where: { id: spent.userId } });
            if (!user || user.email !== spent.email) throw new InvalidToken();
            if (!user.emailVerifiedAt) {
                await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
            }
        });
    }

    /**
     * "Forgot password" (#93). The caller learns nothing: the answer is the same whether or not an
     * account has this address, and mail goes only to an existing account. A provider-only account
     * gets the link too — holding the mailbox is the proof the provider gave. Rate-limited per
     * address+IP, per address and per IP; over any is `429` with no detail. Every request is
     * logged with its IP and user agent, so an unexpected reset mail can be traced to its sender.
     */
    async requestPasswordReset(rawEmail: string, ip: string, userAgent: string): Promise<void> {
        const email = normaliseEmail(rawEmail);
        const overIp = await this.limiter.hit(`reset-ip:${ip}`, RESET_REQUEST_IP_MAX, RESET_REQUEST_WINDOW_S);
        const overAddress = await this.limiter.hit(`reset:${email}`, RESET_REQUEST_ADDRESS_MAX, RESET_REQUEST_WINDOW_S);
        const overPair = await this.limiter.hit(`reset:${email}:${ip}`, RESET_REQUEST_MAX, RESET_REQUEST_WINDOW_S);
        const trail = `password reset for ${email} from ${ip} (${JSON.stringify(userAgent)})`;
        if (overIp || overAddress || overPair) {
            this.logger.warn(`${trail}: rate-limited`);
            throw new TooManyAttempts('too many requests; try again later');
        }
        const mailed = await this.ownerPrisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({ where: { email } });
            if (!user) return false;
            const link = await this.links.issue(tx, 'password_reset', user.id, email);
            await this.mail.passwordReset(tx, email, link);
            return true;
        });
        this.logger.log(`${trail}: ${mailed ? 'link mailed' : 'no such account'}`);
        this.mail.kick();
    }

    /**
     * Spends a reset link (#93): sets the password, marks the address verified (the link was mailed
     * to it), and revokes every session of the account, in one transaction. The caller starts a
     * new session for this browser.
     */
    async resetPassword(token: string, password: string): Promise<UserView> {
        const passwordHash = await this.passwords.hash(password);
        return this.ownerPrisma.$transaction(async (tx) => {
            const spent = await this.links.spend(tx, 'password_reset', token);
            const user = await tx.user.findUnique({ where: { id: spent.userId } });
            if (!user || user.email !== spent.email) throw new InvalidToken();
            const updated = await tx.user.update({
                where: { id: user.id },
                data: { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
            });
            await revokeAllSessions(tx, user.id);
            return userView(updated);
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

/** `403 email.unverified`: the person has not verified their address yet (#93). */
export class EmailUnverified extends ApiException {
    constructor() {
        super(403, 'email.unverified', 'verify your email address first; we sent you a link');
    }
}

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
async function spendSignupInvite(tx: OwnerTx, token: string, email: string): Promise<void> {
    const spent = await tx.platformSignupInvite.updateMany({
        where: { tokenHash: hashToken(token), email, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
    });
    if (spent.count !== 1) throw new SignupInvitationRequired();
}

/**
 * The operator's command for a platform admin (P0-14, #101): `node dist/cli/platform-bootstrap-admin.js
 * <email>`, run on the server. Only an address in `PLATFORM_ADMIN_EMAILS`.
 *
 * - **Account present:** marks its address verified (once; audited `platform.admin_email_verified`).
 * - **Account absent** (a fresh server, sign-up closed): creates it with no password and a verified
 *   address, and issues a single-use set-password link — #93's `password_reset` link and page, the
 *   one mechanism for setting a password from a link — returned for the operator's terminal. No
 *   password is ever printed. Audited `platform.admin_bootstrapped` and `platform.admin_email_verified`;
 *   the link is never in the audit subject.
 */
export async function bootstrapPlatformAdmin(
    owner: PrismaClient,
    env: Pick<Env, 'PLATFORM_ADMIN_EMAILS' | 'WEB_URL'>,
    rawEmail: string,
    links: OneTimeTokenService = new OneTimeTokenService(),
): Promise<{ email: string; created: boolean; alreadyVerified: boolean; setPasswordUrl: string | null }> {
    const email = normaliseEmail(rawEmail);
    if (!env.PLATFORM_ADMIN_EMAILS.includes(email)) {
        throw new Error(`${email} is not in PLATFORM_ADMIN_EMAILS; only a platform admin's address is set up this way`);
    }
    return owner.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({ where: { email } });
        if (existing) {
            if (existing.emailVerifiedAt) return { email, created: false, alreadyVerified: true, setPasswordUrl: null };
            await tx.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: new Date() } });
            await recordPlatformAction(tx, 'platform.admin_email_verified', null, { email });
            return { email, created: false, alreadyVerified: false, setPasswordUrl: null };
        }
        const user = await tx.user.create({ data: { email, emailVerifiedAt: new Date() } });
        await recordPlatformAction(tx, 'platform.admin_bootstrapped', null, { email });
        await recordPlatformAction(tx, 'platform.admin_email_verified', null, { email });
        const link = await links.issue(tx, 'password_reset', user.id, email);
        return {
            email,
            created: true,
            alreadyVerified: false,
            setPasswordUrl: mailedLinkUrl(env.WEB_URL, RESET_PASSWORD_PAGE, link.token),
        };
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
    // OWN-1 (FR-CRMS-18): the manager role, editable like `member`; it moves records between members.
    await tx.role.create({
        data: {
            workspaceId: workspace.id,
            name: SYSTEM_ROLES.manager,
            isSystem: true,
            permissions: {
                create: MANAGER_DEFAULT_CAPABILITIES.map((capability) => ({ workspaceId: workspace.id, capability })),
            },
        },
    });
    // The pipeline deals go into (P1-2), from the one stage list; a workspace is not usable without it.
    await seedDefaultPipeline(tx, workspace.id);
    return { workspace: workspaceView(workspace), adminRoleId: admin.id };
}

async function createWorkspaceWithAdmin(tx: OwnerTx, userId: string, name: string): Promise<WorkspaceView> {
    const { workspace, adminRoleId } = await createWorkspaceShell(tx, name);
    await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId, roleId: adminRoleId, source: 'signup' },
    });
    return workspace;
}

/** How a seat came to be (`workspace_members.source`): the workspace's first admin, an accepted invitation, or the Twenty importer (#184). */
export type SeatSource = 'signup' | 'invite' | 'twenty-import';

/**
 * The one way a user gets a seat in a workspace they are not in (#147, #184): a seat they left comes
 * back as the same seat with this role, so what they did then stays theirs; a seat still held is
 * returned as it is (`held`); none yet is created. `leftAt` makes a new or returning seat a removed one.
 */
export async function takeSeat(
    tx: OwnerTx,
    input: { workspaceId: string; userId: string; roleId: string; source: SeatSource; leftAt?: Date | null },
): Promise<{ memberId: string; created: boolean; held: boolean }> {
    const seat = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
        select: { id: true, leftAt: true },
    });
    if (seat && !seat.leftAt) return { memberId: seat.id, created: false, held: true };
    if (seat) {
        await tx.workspaceMember.update({
            where: { id: seat.id },
            data: { leftAt: input.leftAt ?? null, roleId: input.roleId, source: input.source },
        });
        return { memberId: seat.id, created: false, held: false };
    }
    const created = await tx.workspaceMember
        .create({
            data: {
                workspaceId: input.workspaceId,
                userId: input.userId,
                roleId: input.roleId,
                source: input.source,
                leftAt: input.leftAt ?? null,
            },
        })
        .catch((error: unknown) => {
            throw uniqueViolation(error) ? new UniqueConflict('already a member') : error;
        });
    return { memberId: created.id, created: true, held: false };
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

export function userView(user: {
    id: string;
    email: string;
    emailVerifiedAt: Date | null;
    totpEnabledAt: Date | null;
}): UserView {
    return {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
        twoFactorEnabled: user.totpEnabledAt !== null,
    };
}

export function workspaceView(workspace: { id: string; slug: string; name: string }): WorkspaceView {
    return { id: workspace.id, slug: workspace.slug, name: workspace.name };
}
