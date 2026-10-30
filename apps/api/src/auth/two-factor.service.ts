import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ApiException } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import type { RecoveryCodesView, TwoFactorSetupView, TwoFactorStatusView } from '../workspace/responses';
import { RECOVERY_CODE_BYTES, RECOVERY_CODE_COUNT, TOTP_ISSUER, TWO_FACTOR_MAX_ATTEMPTS } from './auth.constants';
import { OneTimeTokenService } from './one-time-token.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter.service';
import { hashToken } from './tokens';
import { base32Encode, newTotpSecret, otpauthUrl, verifyTotp } from './totp';

type OwnerTx = Prisma.TransactionClient;

/** `400 two_factor.code_invalid`: the code is not the authenticator's current one, nor an unused recovery code. */
export class CodeInvalid extends ApiException {
    constructor() {
        super(400, 'two_factor.code_invalid', 'that code is not right; try the next one your app shows');
    }
}
/** `400 token.invalid`: the challenge is unknown, spent, expired, or has had its five tries. */
export class ChallengeInvalid extends ApiException {
    constructor() {
        super(400, 'token.invalid', 'this sign-in has expired; enter your password again');
    }
}
/** `400 two_factor.not_set_up`: enabling needs a setup first. */
export class NotSetUp extends ApiException {
    constructor() {
        super(400, 'two_factor.not_set_up', 'scan the code first, then enter what your app shows');
    }
}

/**
 * Two-factor sign-in with an authenticator app (2FA-1). The person sets it up, proves the app
 * with one code, and keeps eight recovery codes; from then on a password login answers a
 * challenge, and the session starts only when a current code or an unused recovery code follows.
 * Self-service runs through the restricted client on the person's own row; the sign-in path
 * runs through the owner client, as the password check does.
 */
@Injectable()
export class TwoFactorService {
    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly secrets: SecretBox,
        private readonly passwords: PasswordService,
        private readonly links: OneTimeTokenService,
        private readonly limiter: RateLimiter,
    ) {}

    status(userId: string): Promise<TwoFactorStatusView> {
        return this.rls.withUser(userId, async (tx) => {
            const user = await tx.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
            if (!user) throw new UnauthorizedException();
            const left = user.totpEnabledAt
                ? await tx.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } })
                : 0;
            return {
                enabled: user.totpEnabledAt !== null,
                enabledAt: user.totpEnabledAt?.toISOString() ?? null,
                recoveryCodesLeft: left,
            };
        });
    }

    /** A fresh secret, sealed on the row but not yet enabled: it counts only once a code proves the app. */
    beginSetup(userId: string, email: string): Promise<TwoFactorSetupView> {
        const secret = newTotpSecret();
        return this.rls.withUser(userId, async (tx) => {
            await tx.user.update({
                where: { id: userId },
                data: { totpSecret: this.secrets.seal(secret), totpEnabledAt: null },
            });
            await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
            return { secret, otpauthUrl: otpauthUrl(TOTP_ISSUER, email, secret) };
        });
    }

    /** The first code from the app turns the pending secret on and mints the recovery codes. */
    enable(userId: string, code: string): Promise<RecoveryCodesView> {
        return this.rls.withUser(userId, async (tx) => {
            const user = await tx.user.findUnique({
                where: { id: userId },
                select: { totpSecret: true, totpEnabledAt: true },
            });
            if (!user?.totpSecret) throw new NotSetUp();
            if (!verifyTotp(this.secrets.open(user.totpSecret), code).ok) throw new CodeInvalid();
            await tx.user.update({ where: { id: userId }, data: { totpEnabledAt: user.totpEnabledAt ?? new Date() } });
            return { codes: await this.replaceRecoveryCodes(tx, userId) };
        });
    }

    /** Off again, with the password as proof it is the person; the secret and the codes go. */
    disable(userId: string, password: string): Promise<void> {
        return this.rls.withUser(userId, async (tx) => {
            await this.assertPassword(tx, userId, password);
            await tx.user.update({ where: { id: userId }, data: { totpSecret: null, totpEnabledAt: null } });
            await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
        });
    }

    /** Eight new codes for the password; the old ones stop working at once. */
    regenerateRecoveryCodes(userId: string, password: string): Promise<RecoveryCodesView> {
        return this.rls.withUser(userId, async (tx) => {
            await this.assertPassword(tx, userId, password);
            const user = await tx.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
            if (!user?.totpEnabledAt) throw new NotSetUp();
            return { codes: await this.replaceRecoveryCodes(tx, userId) };
        });
    }

    /** A password login's half-way point: a short-lived token the second factor completes. */
    async challenge(userId: string, email: string): Promise<string> {
        return this.ownerPrisma.$transaction(async (tx) => {
            const link = await this.links.issue(tx, 'two_factor', userId, email);
            return link.token;
        });
    }

    /**
     * Completes a challenge with the app's code or a recovery code, answering the user to sign in.
     * Five wrong codes spend the challenge; a right code spends it too, and a recovery code is used up.
     */
    async complete(challenge: string, code: string): Promise<string> {
        const key = `2fa:${hashToken(challenge)}`;
        if (await this.limiter.hit(key, TWO_FACTOR_MAX_ATTEMPTS, 10 * 60)) throw new ChallengeInvalid();
        const pending = await this.ownerPrisma.oneTimeToken.findFirst({
            where: {
                tokenHash: hashToken(challenge),
                purpose: 'two_factor',
                usedAt: null,
                expiresAt: { gt: new Date() },
            },
            select: { userId: true },
        });
        if (!pending) throw new ChallengeInvalid();
        const user = await this.ownerPrisma.user.findUnique({
            where: { id: pending.userId },
            select: { id: true, totpSecret: true, totpEnabledAt: true },
        });
        if (!user?.totpSecret || !user.totpEnabledAt) throw new ChallengeInvalid();

        const ok = await this.ownerPrisma.$transaction(async (tx) => {
            if (verifyTotp(this.secrets.open(user.totpSecret!), code).ok) return true;
            const spent = await tx.twoFactorRecoveryCode.updateMany({
                where: { userId: user.id, codeHash: hashToken(normaliseRecoveryCode(code)), usedAt: null },
                data: { usedAt: new Date() },
            });
            return spent.count === 1;
        });
        if (!ok) throw new CodeInvalid();
        await this.ownerPrisma.$transaction((tx) => this.links.spend(tx, 'two_factor', challenge));
        await this.limiter.clear(key);
        return user.id;
    }

    private async assertPassword(tx: OwnerTx, userId: string, password: string): Promise<void> {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
        const ok = user?.passwordHash ? await this.passwords.verify(password, user.passwordHash) : false;
        if (!ok) throw new UnauthorizedException('password is incorrect');
    }

    private async replaceRecoveryCodes(tx: OwnerTx, userId: string): Promise<string[]> {
        const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
        await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
        await tx.twoFactorRecoveryCode.createMany({
            data: codes.map((c) => ({ userId, codeHash: hashToken(normaliseRecoveryCode(c)) })),
        });
        return codes;
    }
}

/** `xxxxx-xxxxx`, lower case, from base32 so it has no ambiguous characters a person misreads. */
function newRecoveryCode(): string {
    const raw = base32Encode(randomBytes(RECOVERY_CODE_BYTES)).toLowerCase().slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** What a person typed, as it was issued: case and separators do not matter. */
function normaliseRecoveryCode(code: string): string {
    return code.toLowerCase().replace(/[^a-z2-7]/g, '');
}
