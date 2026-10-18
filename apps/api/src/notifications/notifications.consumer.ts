import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { TaskNotificationsService } from './task-notifications.service';

/**
 * A task made, or handed to someone (#192): its assignee is told. Idempotent — the notification is
 * one row per member, kind and task — so a redelivered event changes nothing.
 */
@Injectable()
@OutboxConsumerOf('task-notifications')
export class TaskNotificationsConsumer implements OutboxConsumer {
    constructor(private readonly notifications: TaskNotificationsService) {}

    accepts(event: DomainEvent): boolean {
        return (
            event.type === 'task.created' || (event.type === 'task.updated' && event.diff?.['assigneeId'] !== undefined)
        );
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        await this.notifications.assigned(event.workspaceId, event.recordId, event.actor);
    }
}
