import { Injectable } from '@nestjs/common';
import { APP_DB_ROLE, type DependencyState, type HealthStatus, type RlsState } from '@bylinecrm/shared';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { VERSION } from '../version';

/** A probe that has not answered by then is reported `down`; a hung socket must not hang `/health`. */
export const PROBE_TIMEOUT_MS = 2_000;

/** What the database says about the role the restricted client logged in as. */
interface RoleRow {
    current_user: string;
    rolbypassrls: boolean;
}

@Injectable()
export class HealthService {
    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly rlsPrisma: RlsPrismaService,
        private readonly redis: RedisService,
    ) {}

    async check(): Promise<HealthStatus> {
        const [db, redis, rls] = await Promise.all([
            probe(() => this.ownerPrisma.$queryRaw`SELECT 1`),
            probe(async () => {
                if (this.redis.status !== 'ready') await this.redis.connect();
                await this.redis.ping();
            }),
            this.rlsState(),
        ]);
        const status = db === 'ok' && redis === 'ok' && rls === 'ok' ? 'ok' : 'degraded';
        return { status, db, redis, rls, version: VERSION };
    }

    /**
     * `ok` only when the restricted client really is the app role and that role cannot bypass
     * row-level security. Anything else — the owner's credentials in RLS_DATABASE_URL, a role
     * someone granted BYPASSRLS, the probe failing — is `misconfigured`, because in every one of
     * those cases tenant isolation is not in force.
     */
    private async rlsState(): Promise<RlsState> {
        const answered = await probe(async () => {
            const rows = await this.rlsPrisma.$queryRaw<RoleRow[]>`
                SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
            const row = rows[0];
            if (!row || row.current_user !== APP_DB_ROLE || row.rolbypassrls) {
                throw new Error('restricted client is not the app role');
            }
        });
        return answered === 'ok' ? 'ok' : 'misconfigured';
    }
}

/** Runs one dependency probe; any rejection or a timeout is `down`. */
async function probe(run: () => Promise<unknown>): Promise<DependencyState> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
    });
    try {
        await Promise.race([run(), timeout]);
        return 'ok';
    } catch {
        // The reason is not reported: /health is unauthenticated and says only up or down.
        return 'down';
    } finally {
        clearTimeout(timer);
    }
}
