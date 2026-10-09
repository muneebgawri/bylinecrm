import { randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { API_KEY_ID_LENGTH, API_KEY_PREFIX } from '@bylinecrm/shared';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { API_KEY_TOUCH_INTERVAL_S } from './auth.constants';
import { digestsEqual, hashToken, randomToken } from './tokens';
import type { ApiKeyView } from '../workspace/responses';
export type { ApiKeyView } from '../workspace/responses';

/** `blc_<prefix>_<secret>`, parsed. */
export interface ParsedApiKey {
    prefix: string;
    secret: string;
}

/** The key that just authenticated, as the auth guard needs it. */
export interface ResolvedApiKey {
    apiKeyId: string;
    workspaceId: string;
    roleId: string;
}

const PREFIX_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Parses the presented string; `null` for anything that is not shaped like a key. */
export function parseApiKey(presented: string): ParsedApiKey | null {
    const match = new RegExp(`^${API_KEY_PREFIX}_([a-z0-9]{${API_KEY_ID_LENGTH}})_([A-Za-z0-9_-]+)$`).exec(presented);
    return match ? { prefix: match[1]!, secret: match[2]! } : null;
}

/**
 * API keys. Creating, listing and revoking happen inside the workspace (RLS). **Resolving** a
 * presented key happens before any workspace is known — it is how the workspace becomes known —
 * so that one read goes through the owner client, by prefix, and the secret is compared by hash
 * in constant time.
 */
@Injectable()
export class ApiKeyService {
    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
    ) {}

    async resolve(presented: string): Promise<ResolvedApiKey | null> {
        const parsed = parseApiKey(presented);
        if (!parsed) return null;
        const key = await this.ownerPrisma.apiKey.findUnique({
            where: { prefix: parsed.prefix },
            select: { id: true, workspaceId: true, roleId: true, secretHash: true, revokedAt: true, lastUsedAt: true },
        });
        if (!key || key.revokedAt || !digestsEqual(key.secretHash, hashToken(parsed.secret))) return null;
        const now = Date.now();
        if (!key.lastUsedAt || now - key.lastUsedAt.getTime() > API_KEY_TOUCH_INTERVAL_S * 1000) {
            await this.ownerPrisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(now) } });
        }
        return { apiKeyId: key.id, workspaceId: key.workspaceId, roleId: key.roleId };
    }

    list(): Promise<ApiKeyView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const keys = await tx.apiKey.findMany({ orderBy: { createdAt: 'asc' } });
            return keys.map(view);
        });
    }

    /** Returns the full key exactly once; afterwards only its prefix is ever shown. */
    create(input: { name: string; roleId: string; createdById: string }): Promise<{ key: ApiKeyView; secret: string }> {
        return this.rls.withWorkspace(async (tx) => {
            const role = await tx.role.findUnique({ where: { id: input.roleId }, select: { workspaceId: true } });
            if (!role) throw new NotFoundException('role not found');
            const prefix = randomPrefix();
            const secret = randomToken();
            const key = await tx.apiKey.create({
                data: {
                    workspaceId: role.workspaceId,
                    name: input.name,
                    prefix,
                    secretHash: hashToken(secret),
                    roleId: input.roleId,
                    createdById: input.createdById,
                },
            });
            return { key: view(key), secret: `${API_KEY_PREFIX}_${prefix}_${secret}` };
        });
    }

    revoke(apiKeyId: string): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            const result = await tx.apiKey.updateMany({
                where: { id: apiKeyId, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            if (result.count === 0) throw new NotFoundException('API key not found or already revoked');
        });
    }
}

function randomPrefix(): string {
    const bytes = randomBytes(API_KEY_ID_LENGTH);
    return [...bytes].map((b) => PREFIX_ALPHABET[b % PREFIX_ALPHABET.length]).join('');
}

function view(key: {
    id: string;
    name: string;
    prefix: string;
    roleId: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
}): ApiKeyView {
    return {
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        roleId: key.roleId,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        revokedAt: key.revokedAt,
    };
}
