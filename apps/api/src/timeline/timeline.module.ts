import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../records/custom-fields/custom-fields.module';
import { DealFeedService } from './deal-feed.service';
import { DealFeedController, TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { TimelineSubscriber } from './timeline.subscriber';

/** The timeline: every record's append-only history, fed by the event bus and by integrations; and the deal feed. */
@Module({
    imports: [CustomFieldsModule],
    controllers: [TimelineController, DealFeedController],
    providers: [TimelineService, TimelineSubscriber, DealFeedService],
    exports: [TimelineService],
})
export class TimelineModule {}
