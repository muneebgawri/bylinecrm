import { Inject, Injectable } from '@nestjs/common';
import { invitationUrl, mailedLinkUrl, RESET_PASSWORD_PAGE, VERIFY_EMAIL_PAGE } from '@bylinecrm/shared';
import { ENV, type Env } from '../config/env';
import {
    passwordResetMail,
    signupInvitationMail,
    twentySyncFailingMail,
    verificationMail,
    workspaceInvitationMail,
} from './templates';
import { MailOutbox, type MailTransaction } from './mail-outbox';

/**
 * The account mail the application sends (#93), one method per kind: it builds the link on the web
 * app (`WEB_URL`), renders the message and records it in `tx` — the transaction that issued the
 * token or wrote the invitation — under its idempotency key. After an owner transaction the caller
 * calls `kick()`; a tenant transaction wakes the relay at its commit.
 */
@Injectable()
export class AccountMail {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly outbox: MailOutbox,
    ) {}

    verification(tx: MailTransaction, to: string, link: { id: string; token: string }): Promise<void> {
        const url = mailedLinkUrl(this.env.WEB_URL, VERIFY_EMAIL_PAGE, link.token);
        return this.outbox.record(tx, {
            kind: 'email_verification',
            to,
            idempotencyKey: `verify-${link.id}`,
            ...verificationMail(url),
        });
    }

    passwordReset(tx: MailTransaction, to: string, link: { id: string; token: string }): Promise<void> {
        const url = mailedLinkUrl(this.env.WEB_URL, RESET_PASSWORD_PAGE, link.token);
        return this.outbox.record(tx, {
            kind: 'password_reset',
            to,
            idempotencyKey: `reset-${link.id}`,
            ...passwordResetMail(url),
        });
    }

    /**
     * A workspace invitation; `owner` for the one a platform admin sends with a new workspace. It is
     * the workspace's own mail, recorded against `workspaceId`.
     */
    workspaceInvitation(
        tx: MailTransaction,
        input: {
            workspaceId: string;
            to: string;
            inviteId: string;
            token: string;
            workspaceName: string;
            owner: boolean;
        },
    ): Promise<void> {
        const url = invitationUrl(this.env.WEB_URL, 'member', input.token);
        return this.outbox.record(
            tx,
            {
                kind: 'workspace_invitation',
                to: input.to,
                idempotencyKey: `${input.owner ? 'owner-invite' : 'invite'}-${input.inviteId}`,
                ...workspaceInvitationMail({ url, workspaceName: input.workspaceName, owner: input.owner }),
            },
            input.workspaceId,
        );
    }

    signupInvitation(tx: MailTransaction, input: { to: string; inviteId: string; token: string }): Promise<void> {
        const url = invitationUrl(this.env.WEB_URL, 'signup', input.token);
        return this.outbox.record(tx, {
            kind: 'signup_invitation',
            to: input.to,
            idempotencyKey: `signup-invite-${input.inviteId}`,
            ...signupInvitationMail(url),
        });
    }

    /**
     * The workspace's automatic Twenty sync has failed several times in a row (#185): one message
     * per admin per run, recorded against the workspace in the transaction that ended the run.
     */
    twentySyncFailing(
        tx: MailTransaction,
        input: {
            workspaceId: string;
            to: string;
            memberId: string;
            runId: string;
            workspaceName: string;
            failures: number;
            error: string;
            url: string;
        },
    ): Promise<void> {
        return this.outbox.record(
            tx,
            {
                kind: 'twenty_sync_failing',
                to: input.to,
                idempotencyKey: `twenty-sync-${input.runId}-${input.memberId}`,
                ...twentySyncFailingMail(input),
            },
            input.workspaceId,
        );
    }

    /** Wakes the relay after an owner transaction that recorded mail has committed. */
    kick(): void {
        this.outbox.kick();
    }
}
