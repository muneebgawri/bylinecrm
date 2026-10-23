import { Injectable } from '@nestjs/common';
import { MAIL_SEND_RECIPIENTS_MAX, SUPPRESSION_REASON_LABELS } from '@bylinecrm/shared';
import { RecipientGuard, RecipientGuarded, type GuardPath } from '../guardrails/recipient-guard';
import { ValidationFailed } from '../infra/errors/api-errors';
import { RecipientSuppressed, SuppressionService } from '../suppression/suppression.service';

/** The header field a recipient is in. */
export type RecipientField = 'to' | 'cc' | 'bcc';

/** One address a message is about to go to, the field it is in, and the person it is, when it is one. */
export interface SendRecipient {
    address: string;
    personId: string | null;
    field: RecipientField;
}

/** How the recipient guard (GUARD-1) is asked: from which path, for a sequence's mail or not, replying to what. */
export interface GuardedSend {
    path: Exclude<GuardPath, 'sequence_enrol'>;
    outreach: boolean;
    replyToMessageId: string | null;
    /** Write the guard's audit (default); `false` asks it quietly, for a check already written once. */
    record?: boolean;
}

/**
 * Whether these recipients may be sent to — the one gate every send passes (P2-3): someone to send
 * to, not more than `MAIL_SEND_RECIPIENTS_MAX`, and nobody on the workspace's suppression list
 * (P3-1, FR-CRMS-7). A suppressed recipient refuses the whole send (`recipient.suppressed`), naming
 * each one at its field with the reason — a send is never quietly trimmed of a recipient. It runs at
 * the request, at a scheduled send's time, and before every delivery attempt. The outreach gates
 * (FR-CRMS-10…14) are P3-3's and go here too. Throws the refusal; returns when every recipient may
 * be sent to.
 */
@Injectable()
export class SendPolicy {
    constructor(
        private readonly suppressions: SuppressionService,
        private readonly guard: RecipientGuard,
    ) {}

    async assertSendable(
        workspaceId: string,
        recipients: readonly SendRecipient[],
        guarded?: GuardedSend,
    ): Promise<void> {
        if (recipients.length === 0) {
            throw new ValidationFailed('a message needs at least one recipient', [
                { path: 'to', message: 'add at least one recipient' },
            ]);
        }
        if (recipients.length > MAIL_SEND_RECIPIENTS_MAX) {
            throw new ValidationFailed(`at most ${MAIL_SEND_RECIPIENTS_MAX} recipients`, [
                { path: 'to', message: `at most ${MAIL_SEND_RECIPIENTS_MAX} recipients (to, cc and bcc together)` },
            ]);
        }
        if (guarded) {
            const verdicts = await this.guard.check({ ...guarded, recipients });
            const suppressedHere = verdicts.filter((v) => v.kind === 'suppressed');
            if (suppressedHere.length > 0) {
                throw new RecipientSuppressed(
                    suppressedHere.map((v) => ({ path: v.field ?? 'to', message: `${v.address}: ${v.message}` })),
                );
            }
            const blocked = verdicts.filter((v) => v.outcome === 'blocked');
            if (blocked.length > 0) throw new RecipientGuarded(blocked);
            return;
        }
        const suppressed = await this.suppressions.check(
            workspaceId,
            recipients.map((r) => r.address),
        );
        if (suppressed.size === 0) return;
        throw new RecipientSuppressed(
            recipients.flatMap((r) => {
                const entry = suppressed.get(r.address.toLowerCase());
                return entry
                    ? [{ path: r.field, message: `${r.address}: ${SUPPRESSION_REASON_LABELS[entry.reason]}` }]
                    : [];
            }),
        );
    }
}
