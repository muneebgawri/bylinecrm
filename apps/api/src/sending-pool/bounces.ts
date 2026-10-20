import type { DomainEvent } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { ParsedBounce } from '../mail-sync/parse-message';

/**
 * A bounce report a pool mailbox just stored (P3-2), written in the same transaction as the report:
 * one `mail_bounces` row per failed address, and an `email.bounced` for each row written. The send
 * that bounced is the one the report names (its `X-BylineCRM-Id`) when it went from this mailbox;
 * otherwise the mailbox's latest send to that address. What follows — suppressing a permanent
 * bounce's address and judging the mailbox's bounce rate — is the outbox consumer's
 * (`SendingPoolConsumer`), so nothing here leaves the transaction.
 */
export async function recordBounces(
    tx: WorkspaceClient,
    mailbox: { id: string; workspaceId: string },
    report: { id: string; sentAt: Date },
    bounce: ParsedBounce,
): Promise<DomainEvent[]> {
    const named = bounce.crmId
        ? await tx.mailOutbound.findFirst({ where: { id: bounce.crmId, mailboxId: mailbox.id }, select: { id: true } })
        : null;
    const events: DomainEvent[] = [];
    for (const recipient of bounce.recipients) {
        const outbound =
            named ??
            (await tx.mailOutbound.findFirst({
                where: {
                    mailboxId: mailbox.id,
                    toAddresses: { has: recipient.address },
                    status: { in: ['sending', 'sent'] },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                select: { id: true },
            }));
        const written = await tx.mailBounce.createManyAndReturn({
            data: [
                {
                    workspaceId: mailbox.workspaceId,
                    mailboxId: mailbox.id,
                    messageId: report.id,
                    address: recipient.address,
                    permanent: recipient.permanent,
                    status: recipient.status,
                    outboundId: outbound?.id ?? null,
                    occurredAt: report.sentAt,
                },
            ],
            skipDuplicates: true,
        });
        if (written.length === 0) continue;
        events.push({
            type: 'email.bounced',
            object: 'email',
            workspaceId: mailbox.workspaceId,
            actor: { kind: 'sync', id: mailbox.id },
            occurredAt: report.sentAt.toISOString(),
            recordId: report.id,
            bounce: {
                mailboxId: mailbox.id,
                address: recipient.address,
                permanent: recipient.permanent,
                status: recipient.status,
                outboundId: outbound?.id ?? null,
            },
        });
    }
    return events;
}

/**
 * A bounce SMTP2Go reported for a pool send that went through it (TRANS-1), in the webhook's transaction: one
 * `mail_bounces` row keyed by SMTP2Go's event (a redelivered webhook writes nothing) and its `email.bounced`, so
 * what follows — a permanent bounce suppressing the address, the mailbox's bounce rate judged — is the same
 * consumer's as for a report Gmail received. `recordId` is the bounce row: there is no stored report message.
 */
export async function recordProviderBounce(
    tx: WorkspaceClient,
    mailbox: { id: string; workspaceId: string },
    bounce: {
        providerEventId: string;
        address: string;
        permanent: boolean;
        status: string | null;
        outboundId: string;
        at: Date;
    },
): Promise<DomainEvent[]> {
    const written = await tx.mailBounce.createManyAndReturn({
        data: [
            {
                workspaceId: mailbox.workspaceId,
                mailboxId: mailbox.id,
                messageId: null,
                providerEventId: bounce.providerEventId,
                address: bounce.address,
                permanent: bounce.permanent,
                status: bounce.status,
                outboundId: bounce.outboundId,
                occurredAt: bounce.at,
            },
        ],
        skipDuplicates: true,
    });
    const row = written[0];
    if (!row) return [];
    return [
        {
            type: 'email.bounced',
            object: 'email',
            workspaceId: mailbox.workspaceId,
            actor: { kind: 'sync', id: mailbox.id },
            occurredAt: bounce.at.toISOString(),
            recordId: row.id,
            bounce: {
                mailboxId: mailbox.id,
                address: bounce.address,
                permanent: bounce.permanent,
                status: bounce.status,
                outboundId: bounce.outboundId,
            },
        },
    ];
}
