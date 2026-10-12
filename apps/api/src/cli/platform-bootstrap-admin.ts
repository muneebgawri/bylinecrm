import { PrismaClient } from '@prisma/client';
import { bootstrapPlatformAdmin } from '../auth/auth.service';
import { parseEnv } from '../config/env';

/**
 * `node dist/cli/platform-bootstrap-admin.js <email>` — run on the server, inside the api container,
 * by the operator (P0-14, #101). Only an address in `PLATFORM_ADMIN_EMAILS`:
 *
 * - an existing account's address is marked verified, so it can use the platform routes;
 * - with no account (a fresh server, sign-up closed), the account is created, verified, and a
 *   single-use set-password link (30 minutes) is printed — never a password.
 *
 * Uses the owner connection (`DATABASE_URL`); every change is audited (`platform_audit`).
 */
async function main(): Promise<void> {
    const email = process.argv[2];
    if (!email) throw new Error('usage: node dist/cli/platform-bootstrap-admin.js <email>');
    const env = parseEnv(process.env);
    const owner = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    try {
        const result = await bootstrapPlatformAdmin(owner, env, email);
        if (result.created) {
            console.log(`${result.email}: account created and verified.`);
            console.log(`Set its password within 30 minutes (single use): ${result.setPasswordUrl}`);
        } else {
            console.log(
                result.alreadyVerified ? `${result.email} was already verified` : `${result.email} is now verified`,
            );
        }
    } finally {
        await owner.$disconnect();
    }
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
