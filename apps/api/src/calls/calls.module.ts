import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecordsModule } from '../records/records.module';
import { CallsController, QuoHookController, QuoSettingsController } from './calls.controllers';
import { CallsService } from './calls.service';
import { QuoHookService } from './quo-hook.service';
import { QuoSettingsService } from './quo-settings.service';
import { QuoHttp } from './quo.http';
import { QUO_API } from './quo.port';

/**
 * Calls with Quo (CALL-1): the workspace's link, the webhook Quo's call events come in through, and the calls a
 * member logs from a record's Call panel. Design note docs/design-notes/CALL-1.md.
 */
@Module({
    imports: [AuthModule, RecordsModule],
    controllers: [QuoSettingsController, QuoHookController, CallsController],
    providers: [CallsService, QuoSettingsService, QuoHookService, { provide: QUO_API, useClass: QuoHttp }],
    exports: [CallsService],
})
export class CallsModule {}
