import { PrismaClient } from '@prisma/client';
import { verifyPlatformAdminEmail } from '../auth/auth.service';
import { parseEnv } from '../config/env';

/**
 * `node dist/cli/platform-verify-email.js <email>` — run on the server, inside the api container,
 * by the operator (P0-14). Marks a platform admin's address verified so the account can use the
 * platform routes; refuses any address not in `PLATFORM_ADMIN_EMAILS`. Uses the owner connection
 * (`DATABASE_URL`) and records a `platform.admin_email_verified` audit row. Until the
 * email-verification card ships, this is how a password account's address becomes verified.
 */
async function main(): Promise<void> {
    const email = process.argv[2];
    if (!email) throw new Error('usage: node dist/cli/platform-verify-email.js <email>');
    const env = parseEnv(process.env);
    const owner = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    try {
        const result = await verifyPlatformAdminEmail(owner, env, email);
        console.log(
            result.alreadyVerified ? `${result.email} was already verified` : `${result.email} is now verified`,
        );
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
