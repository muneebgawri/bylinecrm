import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../records/custom-fields/custom-fields.module';
import { MailSettingsService } from './mail-settings.service';
import { RenderService } from './render.service';
import { MailSettingsController, TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Email templates and the workspace's mail settings (P2-4). `RenderService` is exported: the send
 * path (P2-3) and sequences (P3) render through it and nowhere else.
 */
@Module({
    imports: [CustomFieldsModule],
    controllers: [TemplatesController, MailSettingsController],
    providers: [TemplatesService, MailSettingsService, RenderService],
    exports: [RenderService],
})
export class TemplatesModule {}
