import type { DomainEvent } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import type { WebhooksService } from './webhooks.service';
import { WebhooksSubscriber } from './webhooks.subscriber';

describe('the webhook consumer', () => {
    const subscriber = new WebhooksSubscriber({} as WebhooksService);
    const completed = {
        type: 'transfer.completed',
        object: 'transfer',
        workspaceId: 'w',
        recordId: 't',
        actor: { kind: 'import', id: 'run' },
        occurredAt: new Date(0).toISOString(),
    } as unknown as DomainEvent;

    it('takes every event, a transfer included', () => {
        expect(subscriber.accepts(completed)).toBe(true);
    });

    it('never takes one kept in BylineCRM (an import’s owner fill)', () => {
        expect(subscriber.accepts({ ...completed, internal: true })).toBe(false);
    });
});
