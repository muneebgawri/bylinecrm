import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { SESSION_TOUCH_INTERVAL_S, SESSION_TTL_S } from './auth.constants';
import { hashToken, randomToken } from './tokens';

/** A live session and the user it belongs to, as the auth guard needs them. */
export interface ResolvedSession {
    sessionId: string;
    userId: string;
    /** Whether the user's address is verified (#93): tenant routes refuse an unverified one. */
    emailVerified: boolean;
}

/**
 * Server-side sessions. The browser holds a random token; the database holds its hash, the user,
 * and when it expires. Nothing about roles lives in the token, so a permission change applies on
 * the user's next request. Sessions are global rows read before any workspace is known, so this
 * service uses the owner client — it is one of the two auth-layer writers of global tables
 * (the other is AuthService), and the design note says why.
 */
@Injectable()
export class SessionService {
    constructor(private readonly ownerPrisma: PrismaService) {}

    /** Issues a session; `rotatedFromId` records the session it replaces, which is revoked. */
    async create(userId: string, rotatedFromId?: string): Promise<{ token: string; sessionId: string }> {
        const token = randomToken();
        const session = await this.ownerPrisma.$transaction(async (tx) => {
            if (rotatedFromId) {
                await tx.session.updateMany({
                    where: { id: rotatedFromId, revokedAt: null },
                    data: { revokedAt: new Date() },
                });
            }
            return tx.session.create({
                data: {
                    userId,
                    tokenHash: hashToken(token),
                    expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000),
                    rotatedFromId: rotatedFromId ?? null,
                },
                select: { id: true },
            });
        });
        return { token, sessionId: session.id };
    }

    /**
     * The session a cookie token names, if it is live. Activity slides the expiry, written at
     * most every `SESSION_TOUCH_INTERVAL_S`.
     */
    async resolve(token: string): Promise<ResolvedSession | null> {
        const now = new Date();
        const session = await this.ownerPrisma.session.findUnique({
            where: { tokenHash: hashToken(token) },
            select: {
                id: true,
                userId: true,
                expiresAt: true,
                revokedAt: true,
                lastSeenAt: true,
                user: { select: { emailVerifiedAt: true } },
            },
        });
        if (!session || session.revokedAt || session.expiresAt <= now) return null;
        if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_S * 1000) {
            await this.ownerPrisma.session.update({
                where: { id: session.id },
                data: { lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_S * 1000) },
            });
        }
        return { sessionId: session.id, userId: session.userId, emailVerified: session.user.emailVerifiedAt !== null };
    }

    async revoke(sessionId: string): Promise<void> {
        await this.ownerPrisma.session.updateMany({
            where: { id: sessionId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    }
}

/**
 * Revokes every live session of a user, inside the caller's owner transaction — a password reset
 * (#93) signs the account out everywhere in the same commit that changes the password.
 */
export async function revokeAllSessions(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
