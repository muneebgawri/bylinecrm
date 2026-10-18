import { Body, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { MyTaskView, NotificationSettings, NotificationsView } from '@bylinecrm/shared';
import { AnyMember, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { MarkNotificationsReadDto, NotificationSettingsDto } from './dto';
import { myTaskView, notificationSettingsView, notificationsView } from './responses';
import { TaskNotificationsService } from './task-notifications.service';

/** A member's own notifications (#192): every member has them, so no capability is asked. */
@ApiTags('notifications')
@TenantController('notifications')
export class NotificationsController {
    constructor(private readonly notifications: TaskNotificationsService) {}

    @AnyMember('a member reads their own notifications')
    @Get()
    @Returns(notificationsView)
    list(): Promise<NotificationsView> {
        return this.notifications.list();
    }

    /** Marks your own notifications read — those named, or every one. Anyone else's are untouched. */
    @AnyMember('a member marks their own notifications read')
    @HttpCode(204)
    @Post('read')
    read(@Body() body: MarkNotificationsReadDto): Promise<void> {
        return this.notifications.markRead(body.ids);
    }
}

/** A member's own open tasks (#192), soonest due first, for My tasks. */
@ApiTags('notifications')
@TenantController('my-tasks')
export class MyTasksController {
    constructor(private readonly notifications: TaskNotificationsService) {}

    @AnyMember('a member reads the tasks assigned to them')
    @Get()
    @Returns([myTaskView])
    list(): Promise<MyTaskView[]> {
        return this.notifications.myTasks();
    }
}

/** A member's own notification settings in the workspace (#192). */
@ApiTags('notifications')
@TenantController('notification-settings')
export class NotificationSettingsController {
    constructor(private readonly notifications: TaskNotificationsService) {}

    @AnyMember('a member reads their own notification settings')
    @Get()
    @Returns(notificationSettingsView)
    get(): Promise<NotificationSettings> {
        return this.notifications.settings();
    }

    @AnyMember('a member changes their own notification settings')
    @Put()
    @Returns(notificationSettingsView)
    update(@Body() body: NotificationSettingsDto): Promise<NotificationSettings> {
        return this.notifications.updateSettings(body);
    }
}
