import { z } from 'zod';

/** One OIDC issuer the operator trusts for sign-in (NewswireOS, a customer's provider, …). */
export const oidcIssuerSchema = z.object({
    /** The key in `/api/auth/oidc/:issuer`; letters, digits and hyphens. */
    key: z.string().regex(/^[a-z0-9-]+$/),
    issuerUrl: z.url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
});
export type OidcIssuerConfig = z.infer<typeof oidcIssuerSchema>;

/**
 * Every variable the API needs, validated once at boot. A missing or malformed value stops the
 * process before anything else runs — the alternative is a server that starts and then fails on
 * the first request that touches the unset thing.
 */
export const envSchema = z
    .object({
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
        /**
         * Where this API is reachable from a browser; OIDC redirect URIs are built from it, and an
         * `https:` value is what makes the session cookie `Secure`.
         */
        APP_URL: z.url(),
        /** Where a browser is sent after an identity-provider sign-in completes. */
        WEB_URL: z.url(),
        /**
         * Where attachment bytes are kept by the local-disk driver (P1-1b): a directory, relative
         * to the process's working directory or absolute. Git-ignored; one server's disk. A
         * shared store is a different driver behind the same interface, not a different variable.
         */
        FILE_STORAGE_ROOT: z.string().min(1).default('.data/attachments'),
        /** Google sign-in (identity only). Both or neither. */
        GOOGLE_CLIENT_ID: z.string().min(1).optional(),
        GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
        /** JSON array of OIDC issuers; empty or absent means none beyond Google. */
        OIDC_ISSUERS: z
            .string()
            .optional()
            .transform((raw, ctx) => {
                if (!raw) return [] as OidcIssuerConfig[];
                try {
                    return z.array(oidcIssuerSchema).parse(JSON.parse(raw));
                } catch (error) {
                    ctx.addIssue({ code: 'custom', message: `not a JSON array of issuers: ${String(error)}` });
                    return z.NEVER;
                }
            }),
    })
    .refine((env) => Boolean(env.GOOGLE_CLIENT_ID) === Boolean(env.GOOGLE_CLIENT_SECRET), {
        message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together',
        path: ['GOOGLE_CLIENT_SECRET'],
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
