import { Injectable } from '@nestjs/common';
import type { OneTimeTokenPurpose, Prisma } from '@prisma/client';
import { ApiException } from '../infra/errors/api-errors';
import { EMAIL_VERIFICATION_TTL_S, PASSWORD_RESET_TTL_S } from './auth.constants';
import { hashToken, randomToken } from './tokens';

type OwnerTx = Prisma.TransactionClient;

/** How long a link of each purpose works. */
const TTL_S: Record<OneTimeTokenPurpose, number> = {
    email_verification: EMAIL_VERIFICATION_TTL_S,
    password_reset: PASSWORD_RESET_TTL_S,
};

/** A link just issued: the secret (mailed once, never stored) and the row that holds its hash. */
export interface IssuedToken {
    id: string;
    token: string;
    expiresAt: Date;
}

/** A link just spent. */
export interface SpentToken {
    id: string;
    userId: string;
    email: string;
}

/**
 * Mailed single-use links (#93): verify an address, reset a password — and #101's set-password
 * link. One table and this one service for all of them. The secret is 32 random bytes; only its
 * SHA-256 is stored, so the table leaks nothing usable. Both methods take the owner transaction
 * the caller is in, so issuing a link commits with the change that needed it and spending one
 * commits with what it unlocks.
 */
@Injectable()
export class OneTimeTokenService {
    /**
     * Issues a link of `purpose` for a user and the address it will be mailed to. The user's unspent
     * links of the same purpose are deleted: only the newest mail works.
     */
    async issue(tx: OwnerTx, purpose: OneTimeTokenPurpose, userId: string, email: string): Promise<IssuedToken> {
        await tx.oneTimeToken.deleteMany({ where: { userId, purpose, usedAt: null } });
        const token = randomToken();
        const expiresAt = new Date(Date.now() + TTL_S[purpose] * 1000);
        const row = await tx.oneTimeToken.create({
            data: { purpose, userId, email, tokenHash: hashToken(token), expiresAt },
            select: { id: true },
        });
        return { id: row.id, token, expiresAt };
    }

    /**
     * Spends a link of `purpose`, or refuses with `400 token.invalid`. Unknown, tampered, spent,
     * expired and other-purpose links all get that one answer. The conditional update makes a link
     * good exactly once even when two requests race.
     */
    async spend(tx: OwnerTx, purpose: OneTimeTokenPurpose, token: string): Promise<SpentToken> {
        const tokenHash = hashToken(token);
        const spent = await tx.oneTimeToken.updateMany({
            where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } },
            data: { usedAt: new Date() },
        });
        if (spent.count !== 1) throw new InvalidToken();
        const row = await tx.oneTimeToken.findUniqueOrThrow({
            where: { tokenHash },
            select: { id: true, userId: true, email: true },
        });
        return row;
    }
}

/** `400 token.invalid`: the link is unknown, spent, expired or for something else. */
export class InvalidToken extends ApiException {
    constructor() {
        super(400, 'token.invalid', 'this link is invalid or has expired; ask for a new one');
    }
}
