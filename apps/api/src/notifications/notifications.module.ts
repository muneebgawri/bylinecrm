import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransactionalMailModule } from '../transactional-mail/transactional-mail.module';
import {
    MyTasksController,
    NotificationSettingsController,
    NotificationsController,
} from './notifications.controllers';
import { NOTIFICATIONS_MAINTENANCE_QUEUE } from './notifications.constants';
import { TaskNotificationsConsumer } from './notifications.consumer';
import { NotificationsWorkers } from './notifications.workers';
import { TaskNotificationsService } from './task-notifications.service';

/**
 * Task notifications (#192): what members are told about their tasks — assigned (the outbox
 * consumer), due and the morning digest (the repeating jobs) — and what they read of it: the bell,
 * My tasks and their digest setting. Tasks are read straight from the database; the digest goes
 * through the transactional mail outbox.
 */
@Module({
    imports: [
        AuthModule,
        TransactionalMailModule,
        BullModule.registerQueue({
            name: NOTIFICATIONS_MAINTENANCE_QUEUE,
            defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
        }),
    ],
    controllers: [NotificationsController, MyTasksController, NotificationSettingsController],
    providers: [TaskNotificationsService, TaskNotificationsConsumer, NotificationsWorkers],
})
export class NotificationsModule {}
