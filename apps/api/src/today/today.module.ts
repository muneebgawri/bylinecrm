import { Module } from '@nestjs/common';
import { TodayController } from './today.controller';
import { TodayService } from './today.service';

/** Today (#360): a member's day in five sections, read straight from the records, mail and tasks. */
@Module({
    controllers: [TodayController],
    providers: [TodayService],
})
export class TodayModule {}
