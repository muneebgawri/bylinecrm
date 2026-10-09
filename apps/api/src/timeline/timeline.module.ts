import { Module } from '@nestjs/common';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { TimelineSubscriber } from './timeline.subscriber';

/** The timeline: every record's append-only history, fed by the event bus and by integrations. */
@Module({
    controllers: [TimelineController],
    providers: [TimelineService, TimelineSubscriber],
    exports: [TimelineService],
})
export class TimelineModule {}
