import { Injectable } from '@nestjs/common';
import { MAIL_SEND_RECIPIENTS_MAX } from '@bylinecrm/shared';
import { ValidationFailed } from '../infra/errors/api-errors';

/** One address a message is about to go to, and the person it is, when it is one. */
export interface SendRecipient {
    address: string;
    personId: string | null;
}

/**
 * Whether these recipients may be sent to — the one gate every send passes (P2-3), with the checks
 * that exist today: someone to send to, and not more than `MAIL_SEND_RECIPIENTS_MAX`. Recipient
 * suppression (unsubscribes, bounces, complaints; FR-CRMS-7) and the outreach gates
 * (FR-CRMS-10…14) are Phase 3, and they go here, so sending itself does not change when they
 * arrive. Throws the refusal; returns when every recipient may be sent to.
 */
@Injectable()
export class SendPolicy {
    assertSendable(recipients: readonly SendRecipient[]): Promise<void> {
        if (recipients.length === 0) {
            return Promise.reject(
                new ValidationFailed('a message needs at least one recipient', [
                    { path: 'to', message: 'add at least one recipient' },
                ]),
            );
        }
        if (recipients.length > MAIL_SEND_RECIPIENTS_MAX) {
            return Promise.reject(
                new ValidationFailed(`at most ${MAIL_SEND_RECIPIENTS_MAX} recipients`, [
                    { path: 'to', message: `at most ${MAIL_SEND_RECIPIENTS_MAX} recipients (to, cc and bcc together)` },
                ]),
            );
        }
        return Promise.resolve();
    }
}
