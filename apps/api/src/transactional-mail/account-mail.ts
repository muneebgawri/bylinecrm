import { Inject, Injectable } from '@nestjs/common';
import { invitationUrl, mailedLinkUrl, RESET_PASSWORD_PAGE, VERIFY_EMAIL_PAGE } from '@bylinecrm/shared';
import { ENV, type Env } from '../config/env';
import { passwordResetMail, signupInvitationMail, verificationMail, workspaceInvitationMail } from './templates';
import { TransactionalMailer } from './transactional-mailer';

/**
 * The account mail the application sends (#93), one method per kind: it builds the link on the web
 * app (`WEB_URL`), renders the message and queues it under its idempotency key. Callers call it
 * after the transaction that issued the token or wrote the invitation has committed.
 */
@Injectable()
export class AccountMail {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly mailer: TransactionalMailer,
    ) {}

    verification(to: string, link: { id: string; token: string }): Promise<void> {
        const url = mailedLinkUrl(this.env.WEB_URL, VERIFY_EMAIL_PAGE, link.token);
        return this.mailer.enqueue({
            kind: 'email_verification',
            to,
            idempotencyKey: `verify-${link.id}`,
            ...verificationMail(url),
        });
    }

    passwordReset(to: string, link: { id: string; token: string }): Promise<void> {
        const url = mailedLinkUrl(this.env.WEB_URL, RESET_PASSWORD_PAGE, link.token);
        return this.mailer.enqueue({
            kind: 'password_reset',
            to,
            idempotencyKey: `reset-${link.id}`,
            ...passwordResetMail(url),
        });
    }

    /** A workspace invitation; `owner` for the one a platform admin sends with a new workspace. */
    workspaceInvitation(input: {
        to: string;
        inviteId: string;
        token: string;
        workspaceName: string;
        owner: boolean;
    }): Promise<void> {
        const url = invitationUrl(this.env.WEB_URL, 'member', input.token);
        return this.mailer.enqueue({
            kind: 'workspace_invitation',
            to: input.to,
            idempotencyKey: `${input.owner ? 'owner-invite' : 'invite'}-${input.inviteId}`,
            ...workspaceInvitationMail({ url, workspaceName: input.workspaceName, owner: input.owner }),
        });
    }

    signupInvitation(input: { to: string; inviteId: string; token: string }): Promise<void> {
        const url = invitationUrl(this.env.WEB_URL, 'signup', input.token);
        return this.mailer.enqueue({
            kind: 'signup_invitation',
            to: input.to,
            idempotencyKey: `signup-invite-${input.inviteId}`,
            ...signupInvitationMail(url),
        });
    }
}
