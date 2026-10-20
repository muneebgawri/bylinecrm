import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SuppressionModule } from '../suppression/suppression.module';
import { TrackingModule } from '../tracking/tracking.module';
import { PoolSmtpHookController, PoolSmtpMailboxesController } from './smtp2go.controllers';
import { Smtp2GoHookService } from './smtp2go-hook.service';
import { Smtp2GoMailboxesService } from './smtp2go-mailboxes.service';
import { Smtp2GoHttp } from './smtp2go.http';
import { SMTP2GO_PORT } from './smtp2go.port';

/**
 * SMTP2Go as the outreach pool's second transport (TRANS-1, docs/design-notes/TRANS-1.md): its pool mailboxes
 * (an admin's), its webhook, and the port the send job sends through — the HTTP adapter here, a fake in tests.
 */
@Module({
    imports: [AuthModule, SuppressionModule, TrackingModule],
    controllers: [PoolSmtpMailboxesController, PoolSmtpHookController],
    providers: [
        Smtp2GoMailboxesService,
        Smtp2GoHookService,
        { provide: SMTP2GO_PORT, useFactory: () => new Smtp2GoHttp() },
    ],
    exports: [SMTP2GO_PORT],
})
export class Smtp2GoModule {}
