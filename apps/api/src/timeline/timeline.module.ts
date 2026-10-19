import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../records/custom-fields/custom-fields.module';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { TimelineSubscriber } from './timeline.subscriber';

/** The timeline: every record's append-only history, fed by the event bus and by integrations. */
@Module({
    imports: [CustomFieldsModule],
    controllers: [TimelineController],
    providers: [TimelineService, TimelineSubscriber],
    exports: [TimelineService],
})
export class TimelineModule {}
