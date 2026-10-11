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
/** `0` or `1`, read as a boolean, with its default spelled the same way. */
const flag = (fallback: '0' | '1') =>
    z
        .enum(['0', '1'])
        .default(fallback)
        .transform((value) => value === '1');

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
        /**
         * The key secrets-at-rest are encrypted with (`SecretBox`, P1-5): 32 random bytes, base64.
         * A webhook's signing secret cannot be stored as a hash — the application has to use it —
         * so it is sealed with this. Losing the key makes every sealed secret unusable; rotating
         * it is a re-seal, not a variable change. Generate one with `openssl rand -base64 32`.
         */
        SECRETS_KEY: z
            .string()
            .min(1)
            .transform((raw, ctx) => {
                const key = Buffer.from(raw, 'base64');
                if (key.length !== 32) {
                    ctx.addIssue({ code: 'custom', message: 'must be 32 bytes, base64-encoded' });
                    return z.NEVER;
                }
                return key;
            }),
        /**
         * Whether this process runs the webhook delivery worker (P1-5). On by default so a single
         * API process delivers; a deployment that wants a separate worker process sets `0` on the
         * API and `1` on the worker. `0` also keeps compile-only runs (the OpenAPI writer) quiet.
         */
        WEBHOOK_WORKER: flag('1'),
        /**
         * Lets a webhook endpoint point at a private or loopback address. Off by default: an
         * endpoint URL is an attacker's reach into the network the API runs in (SSRF), and the
         * guard refuses RFC 1918, loopback and link-local targets. Local development and the
         * cross-tenant suite deliver to a receiver on 127.0.0.1 and set it to `1`.
         */
        WEBHOOK_ALLOW_PRIVATE_TARGETS: flag('0'),
        /**
         * Whether this process runs the mail-sync worker (P2-2): the every-few-minutes sync of each
         * connected mailbox and the first import when one connects. On by default, like webhooks; a
         * separate worker process sets `1` there and `0` on the API. The cross-tenant suite sets `0`:
         * it drives sync directly against a fake Gmail, and no worker may reach the real one.
         */
        MAIL_SYNC_WORKER: flag('1'),
        /**
         * Whether this process runs the mail-send worker (P2-3): the job that sends a queued message
         * through Gmail. On by default; a separate worker process sets `1` there and `0` on the API.
         * The cross-tenant suite sets `0` and delivers sends itself against a fake Gmail.
         */
        MAIL_SEND_WORKER: flag('1'),
        /**
         * Whether this process relays the outbox (P1-6): delivers recorded domain events to the
         * timeline, webhooks, stage rules and mail re-matching. On by default; any number of processes
         * may relay at once (claims never overlap), and at least one must. `0` keeps compile-only runs
         * (the OpenAPI writer) quiet.
         */
        OUTBOX_RELAY: flag('1'),
        /**
         * Whether the tenant client reports each operation, with the request it belongs to, to
         * `observeQueries` (P1-4a). Off in production — an operation observer is a test instrument,
         * not a feature. The unit and cross-tenant suites set it to `1`; their query-budget tests
         * (no N+1) need it.
         */
        DB_QUERY_EVENTS: flag('0'),
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
