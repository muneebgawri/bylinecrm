import { randomUUID } from 'node:crypto';
import type { RedisService } from '../infra/redis.service';
import { TOKEN_LOCK_POLL_MS, TOKEN_LOCK_TTL_MS } from './mail-accounts.constants';

/** Deletes the lock only if this caller still holds it (its token matches): never another's. */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * One Google grant is refreshed by one process at a time (P2-1): `stored` answers the usable token
 * when there is one; otherwise the caller that takes the lock runs `refresh` (which reads again
 * first — another process may have refreshed meanwhile) and the others wait for it and read the
 * result, so two workers never race Google with the same refresh token. A mailbox's grant and the
 * workspace's Postmaster Tools grant (#129) share this one mechanism, under their own keys.
 */
export async function tokenUnderLock(
    redis: RedisService,
    key: string,
    stored: () => Promise<string | null>,
    refresh: () => Promise<string>,
): Promise<string> {
    const deadline = Date.now() + TOKEN_LOCK_TTL_MS;
    for (;;) {
        const fresh = await stored();
        if (fresh) return fresh;
        const lockToken = await acquire(redis, key);
        if (lockToken) {
            try {
                return await refresh();
            } finally {
                await redis.eval(RELEASE_LOCK, 1, key, lockToken);
            }
        }
        if (Date.now() >= deadline) throw new Error('timed out waiting for another process to refresh the token');
        await sleep(TOKEN_LOCK_POLL_MS);
    }
}

async function acquire(redis: RedisService, key: string): Promise<string | null> {
    await redis.ensureReady();
    const token = randomUUID();
    const ok = await redis.set(key, token, 'PX', TOKEN_LOCK_TTL_MS, 'NX');
    return ok === 'OK' ? token : null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
