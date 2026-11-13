import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import { OwnershipPushService } from '../invoices/ownership-push.service';
import { quietWorkers } from './job-common';

const USAGE = 'usage: node dist/cli/resend-ownership-pushes.js <workspace-slug> --estimate|--apply';

/**
 * `node dist/cli/resend-ownership-pushes.js <workspace-slug> --estimate|--apply` — run on the server, in its own
 * container. Puts back in line the ownership pushes (PNW-765) that failed because NewswireOS was unavailable or
 * throttling (`OwnershipPushService.resendUnavailable`); the running API's push worker sends them, at its pace.
 * `--estimate` only counts.
 */
async function main(): Promise<void> {
    const [slug, flag, ...rest] = process.argv.slice(2);
    if (!slug || slug.startsWith('--') || rest.length > 0 || (flag !== '--estimate' && flag !== '--apply')) {
        throw new Error(USAGE);
    }
    const apply = flag === '--apply';
    quietWorkers();
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const workspace = await app.get(PrismaService).workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const r = await app.get(OwnershipPushService).resendUnavailable(workspace.id, apply);
        console.log(`${r.found} ownership push(es) failed because NewswireOS was unavailable or throttling`);
        console.log(
            apply
                ? `queued ${r.queued} again: the API's push worker sends them, one a second`
                : 'estimate: nothing changed; add --apply to queue them again',
        );
    } finally {
        await app.close();
    }
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
