import { z } from 'zod';

/**
 * Every variable the API needs, validated once at boot. A missing or malformed value stops the
 * process before anything else runs — the alternative is a server that starts and then fails on
 * the first request that touches the unset thing.
 */
export const envSchema = z.object({
    /** The owner connection: migrations and administrative operations only. */
    DATABASE_URL: z.url(),
    /**
     * The restricted connection every tenant query runs on. The name is exact: a different
     * variable would be ignored here, the app would fall back to nothing, and boot would stop —
     * which is the point. It must log in as APP_DB_ROLE; the health probe and the cross-tenant
     * suite both check that it does.
     */
    RLS_DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    PORT: z.coerce.number().int().positive(),
});

export type Env = z.infer<typeof envSchema>;

/** Injection token for the parsed, typed environment. */
export const ENV = Symbol('ENV');

export function parseEnv(source: NodeJS.ProcessEnv): Env {
    const result = envSchema.safeParse(source);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
        throw new Error(`Invalid environment:\n  ${issues}`);
    }
    return result.data;
}
