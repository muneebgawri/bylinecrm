import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../records/custom-fields/custom-fields.module';
import { MailSettingsService } from './mail-settings.service';
import { RenderService } from './render.service';
import { MailSettingsController, TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Email templates and the workspace's mail settings (P2-4). `RenderService` is exported: the send
 * path (P2-3) and sequences (P3) render through it and nowhere else. `TemplatesService` is exported
 * so the send path reads a template, and checks a free-form message, by the templates' own rules.
 */
@Module({
    imports: [CustomFieldsModule],
    controllers: [TemplatesController, MailSettingsController],
    providers: [TemplatesService, MailSettingsService, RenderService],
    exports: [RenderService, TemplatesService],
})
export class TemplatesModule {}
