import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Emails, RichText } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { ApiException, ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { MailboxUnavailable } from '../mail-accounts/mailbox-tokens.service';
import { MailboxesService } from '../mail-accounts/mailboxes.service';
import { GMAIL_PORT, GmailApiError, type GmailPort, type GmailSent } from '../mail-sync/gmail.port';
import { GMAIL_UNITS } from '../mail-sync/mail-sync.constants';
import { MailSyncService } from '../mail-sync/mail-sync.service';
import type { RetryOptions } from '../mail-sync/retry';
import { recordWhere } from '../records/record-scope';
import { RenderService } from '../templates/render.service';
import { TemplatesService } from '../templates/templates.service';
import { MAIL_SEND_QUEUE } from './mail-send.constants';
import type { MailSendJob } from './mail-send.workers';
import { buildMime, newMessageId, replySubject, type MimeAddress } from './mime';
import type { MailOutboundView, MailSendQueued } from './responses';
import { SendPolicy, type SendRecipient } from './send-policy';

type OutboundRow = Prisma.MailOutboundGetPayload<object>;

/** A recipient as the request names it. */
type RecipientInput = { personId: string } | { address: string };

export interface SendInput {
    mailboxId: string;
    personId: string;
    dealId?: string | undefined;
    to?: RecipientInput[] | undefined;
    cc?: RecipientInput[] | undefined;
    bcc?: RecipientInput[] | undefined;
    templateId?: string | undefined;
    subject?: string | undefined;
    body?: RichText | undefined;
    replyToMessageId?: string | undefined;
}

/** Why the last attempt failed, as kept on the row. Never a token or a raw Google body. */
interface SendErrorRecord {
    code: string;
    message: string;
    at: string;
}

/** How a delivery ended: sent (now, or found already sent), failed for good, or nothing to do. */
export type DeliveryOutcome = 'sent' | 'already_sent' | 'failed' | 'skipped';

/**
 * Sending (P2-3, FR-CRMS-2/3): a member sends from their own connected personal mailbox, through
 * Gmail, as a queued job.
 *
 * `compose` (the request) decides everything about the message and stores it, built: who it is
 * from and to, what it says (a template, or a subject and body, rendered through the template
 * renderer — one path; a render with an empty variable is refused, never sent blank), and how it
 * threads (a reply carries `In-Reply-To` / `References` and goes into the parent's Gmail thread).
 * Every send passes `SendPolicy` (Phase 3's suppression goes there).
 *
 * `deliver` (the job) sends the stored MIME. Gmail's answer to a `5xx` or a timeout does not say
 * whether the message went, so before every retry — and on a delivery after an attempt that
 * started — it looks for our Message-ID in the mailbox first; a message Gmail already has is
 * recorded, never sent again. A sent message is stored through mail sync's one writer, which
 * announces it once (`email.sent`) and links it to this send.
 */
@Injectable()
export class MailSendService {
    private readonly logger = new Logger(MailSendService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly mailboxes: MailboxesService,
        private readonly templates: TemplatesService,
        private readonly renderer: RenderService,
        private readonly policy: SendPolicy,
        private readonly sync: MailSyncService,
        @Inject(GMAIL_PORT) private readonly gmail: GmailPort,
        @InjectQueue(MAIL_SEND_QUEUE) private readonly queue: Queue,
    ) {}

    // ── The request: decide, build, store, queue ─────────────────────────────────────────────

    async compose(input: SendInput): Promise<MailSendQueued> {
        const context = this.current();
        const memberId = context.memberId;
        if (!memberId) throw new ApiException(403, 'forbidden', "mail is sent from a member's own mailbox");

        const mailbox = await this.mailboxes.get(input.mailboxId);
        if (mailbox.purpose === 'pool') {
            throw new ApiException(403, 'forbidden', 'a pool mailbox sends only through sequences');
        }
        if (mailbox.ownerMemberId !== memberId) {
            throw new ApiException(403, 'forbidden', 'mail is sent from your own personal mailbox');
        }
        if (mailbox.status !== 'connected') throw new MailboxUnavailable(mailbox.status);

        const { sender, recipients, parent } = await this.rls.withWorkspace(async (tx) => {
            const scope = recordWhere(context, false);
            const person = await tx.person.findFirst({ where: { id: input.personId, ...scope } });
            if (!person) throw new NotFoundException('person not found');
            const resolve = (list: RecipientInput[] | undefined, path: string) =>
                resolveRecipients(tx, context, list ?? [], path);
            const to = input.to ? await resolve(input.to, 'to') : [primaryOf(person, 'personId')];
            const member = await tx.workspaceMember.findUniqueOrThrow({
                where: { id: memberId },
                // The person's display name (P1-UI-10): one per person, read wherever a member is named.
                select: { user: { select: { displayName: true } } },
            });
            let parentRow: Prisma.MailMessageGetPayload<{ include: { thread: true } }> | null = null;
            if (input.replyToMessageId) {
                parentRow = await tx.mailMessage.findUnique({
                    where: { id: input.replyToMessageId },
                    include: { thread: true },
                });
                if (!parentRow) throw new NotFoundException('message not found');
                if (parentRow.mailboxId !== mailbox.id) {
                    throw new ValidationFailed('a reply goes from the mailbox the message is in', [
                        { path: 'replyToMessageId', message: 'not a message in the sending mailbox' },
                    ]);
                }
            }
            return {
                sender: member.user.displayName,
                recipients: {
                    to,
                    cc: await resolve(input.cc, 'cc'),
                    bcc: await resolve(input.bcc, 'bcc'),
                },
                parent: parentRow,
            };
        });

        // What it says: a template, or a subject and body checked by the templates' own rule.
        let draft: { kind: 'personal'; subject: string; body: RichText };
        if (input.templateId) {
            const template = await this.templates.get(input.templateId);
            if (template.kind === 'outreach') {
                throw new ApiException(
                    422,
                    'unprocessable',
                    'an outreach template is sent by a sequence, not one by one',
                    [{ path: 'templateId', message: 'an outreach template' }],
                );
            }
            draft = { kind: 'personal', subject: template.subject, body: template.body };
        } else {
            draft = { kind: 'personal', subject: input.subject ?? '', body: input.body! };
            await this.templates.validateDraft(draft);
        }
        const rendered = await this.renderer.render(draft, {
            personId: input.personId,
            dealId: input.dealId,
            senderMemberId: memberId,
        });
        if (!rendered.sendable) {
            throw new ApiException(
                422,
                'unprocessable',
                `these variables have no value for this person: ${rendered.missing.join(', ')}`,
                rendered.missing.map((path) => ({ path, message: 'has no value' })),
            );
        }
        // A reply with no subject of its own takes the parent's, as written — never rendered, so
        // braces in someone else's subject are not variables.
        const subject =
            parent && !input.templateId && (input.subject === undefined || input.subject === '')
                ? replySubject(parent.subject)
                : rendered.subject;

        const all: SendRecipient[] = [...recipients.to, ...recipients.cc, ...recipients.bcc];
        await this.policy.assertSendable(all);

        const rfc822MessageId = newMessageId();
        const references = parent
            ? [...parent.references, ...(parent.rfc822MessageId ? [parent.rfc822MessageId] : [])]
            : [];
        const mime = buildMime({
            from: { address: mailbox.email, name: sender },
            to: recipients.to.map(toMime),
            cc: recipients.cc.map(toMime),
            bcc: recipients.bcc.map(toMime),
            subject,
            text: rendered.text,
            html: rendered.html,
            messageId: rfc822MessageId,
            inReplyTo: parent?.rfc822MessageId ?? null,
            references,
            date: new Date(),
        });

        const row = await this.rls.withWorkspace((tx) =>
            tx.mailOutbound.create({
                data: {
                    workspaceId: context.workspaceId,
                    mailboxId: mailbox.id,
                    senderMemberId: memberId,
                    personId: input.personId,
                    dealId: input.dealId ?? null,
                    templateId: input.templateId ?? null,
                    replyToMessageId: parent?.id ?? null,
                    rfc822MessageId,
                    toAddresses: recipients.to.map((r) => r.address),
                    ccAddresses: recipients.cc.map((r) => r.address),
                    bccAddresses: recipients.bcc.map((r) => r.address),
                    subject,
                    mime,
                },
            }),
        );
        const job: MailSendJob = { workspaceId: context.workspaceId, messageId: row.id };
        await this.queue.add('send', job, { jobId: row.id });
        return { messageId: row.id, status: 'queued' };
    }

    /** A send as its sender (or an admin) sees it; `404` for anyone else, never a hint that it exists. */
    async status(id: string): Promise<MailOutboundView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.mailOutbound.findUnique({
                where: { id },
                include: { mailMessage: { select: { threadId: true } } },
            });
            const isAdmin = context.capabilities.has('workspace:admin');
            if (!row || (!isAdmin && row.senderMemberId !== context.memberId)) {
                throw new NotFoundException('message not found');
            }
            return view(row, row.mailMessage?.threadId ?? null);
        });
    }

    // ── The job: send the stored MIME, exactly once ──────────────────────────────────────────

    /**
     * Sends one stored message. Runs outside any request (a worker job): the workspace is passed
     * explicitly. A failure worth retrying is recorded and rethrown, so the queue retries the job;
     * a failure that will not change (the mailbox stopped working, Gmail refused the message) marks
     * the send failed and returns.
     */
    async deliver(workspaceId: string, id: string, retry: RetryOptions = {}): Promise<DeliveryOutcome> {
        const row = await this.rls.withWorkspace(workspaceId, (tx) => tx.mailOutbound.findUnique({ where: { id } }));
        if (!row || row.status === 'sent' || row.status === 'failed') return 'skipped';
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: row.mailboxId } }),
        );
        if (!mailbox) return 'skipped';
        if (mailbox.status !== 'connected') {
            await this.markFailed(workspaceId, id, unavailableError(mailbox.status));
            return 'failed';
        }

        const startedBefore = row.status === 'sending';
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailOutbound.update({
                where: { id },
                data: { status: 'sending', attempts: { increment: 1 }, lastAttemptAt: new Date() },
            }),
        );
        const threadId = await this.parentThread(workspaceId, row);

        let sent: { message: GmailSent; found: boolean };
        try {
            let attempt = 0;
            sent = await this.sync.gmailRequest(mailbox, GMAIL_UNITS.send, retry, async (token) => {
                attempt += 1;
                // An attempt that may have reached Gmail is looked for before anything is sent again.
                if (attempt > 1 || startedBefore) {
                    const found = await this.findSent(token, row.rfc822MessageId);
                    if (found) return { message: found, found: true };
                }
                const message = await this.gmail.send(token, { raw: row.mime, ...(threadId ? { threadId } : {}) });
                return { message, found: false };
            });
        } catch (error) {
            if (error instanceof MailboxUnavailable) {
                await this.markFailed(workspaceId, id, unavailableError(error.mailboxStatus));
                return 'failed';
            }
            if (error instanceof GmailApiError && !error.transient) {
                await this.markFailed(workspaceId, id, gmailError(error));
                return 'failed';
            }
            await this.recordError(
                workspaceId,
                id,
                error instanceof GmailApiError ? gmailError(error) : internalError(),
            );
            throw error;
        }

        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailOutbound.update({
                where: { id },
                data: {
                    status: 'sent',
                    providerMessageId: sent.message.id,
                    providerThreadId: sent.message.threadId,
                    sentAt: new Date(),
                    lastError: Prisma.DbNull,
                },
            }),
        );
        // Stored through sync's one writer, which announces it once and links it to this send. A
        // failure here is not the send's: the message went, and the next sync stores it.
        try {
            await this.sync.importMessage(workspaceId, mailbox.id, sent.message.id, retry);
        } catch (error) {
            this.logger.warn(
                `send ${id}: sent as ${sent.message.id}, not stored yet (${error instanceof Error ? error.message : String(error)}); the next sync stores it`,
            );
        }
        return sent.found ? 'already_sent' : 'sent';
    }

    /** The queue's attempts are spent: the send failed, unless it went after all. */
    async markExhausted(workspaceId: string, id: string, code: string): Promise<void> {
        await this.markFailed(workspaceId, id, {
            code,
            message: 'the message could not be sent; Gmail kept failing',
            at: new Date().toISOString(),
        });
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    /** The Gmail thread a reply goes into: the parent's. */
    private async parentThread(workspaceId: string, row: OutboundRow): Promise<string | null> {
        if (!row.replyToMessageId) return null;
        const parent = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailMessage.findUnique({
                where: { id: row.replyToMessageId! },
                select: { thread: { select: { providerThreadId: true } } },
            }),
        );
        return parent?.thread.providerThreadId ?? null;
    }

    /** The message in the mailbox with our Message-ID, if Gmail has it. */
    private async findSent(token: string, rfc822MessageId: string): Promise<GmailSent | null> {
        const page = await this.gmail.listMessages(token, { query: `rfc822msgid:${rfc822MessageId}` });
        const first = page.messages[0];
        return first ? { id: first.id, threadId: first.threadId } : null;
    }

    private async markFailed(workspaceId: string, id: string, error: SendErrorRecord): Promise<void> {
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailOutbound.updateMany({
                where: { id, status: { not: 'sent' } },
                data: { status: 'failed', lastError: error as unknown as Prisma.InputJsonValue },
            }),
        );
    }

    private async recordError(workspaceId: string, id: string, error: SendErrorRecord): Promise<void> {
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailOutbound.update({ where: { id }, data: { lastError: error as unknown as Prisma.InputJsonValue } }),
        );
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('MailSendService is used inside a workspace scope');
        return context;
    }
}

/** The person's primary address as a recipient; `422` when they have none. */
function primaryOf(person: { id: string; emails: unknown }, path: string): SendRecipient {
    const primary = (person.emails as Emails | null)?.primary;
    if (!primary) {
        throw new ApiException(422, 'unprocessable', 'this person has no email address', [
            { path, message: 'has no primary email address' },
        ]);
    }
    return { address: primary.toLowerCase(), personId: person.id };
}

/** Each recipient as an address: a person by their primary (read under the caller's scope), an address as given. */
async function resolveRecipients(
    tx: Prisma.TransactionClient,
    context: WorkspaceRunContext,
    list: RecipientInput[],
    path: string,
): Promise<SendRecipient[]> {
    const out: SendRecipient[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
        let recipient: SendRecipient;
        if ('personId' in entry) {
            const person = await tx.person.findFirst({ where: { id: entry.personId, ...recordWhere(context, false) } });
            if (!person) throw new NotFoundException('person not found');
            recipient = primaryOf(person, `${path}.${index}.personId`);
        } else {
            recipient = { address: entry.address.toLowerCase(), personId: null };
        }
        if (seen.has(recipient.address)) continue;
        seen.add(recipient.address);
        out.push(recipient);
    }
    return out;
}

function toMime(recipient: SendRecipient): MimeAddress {
    return { address: recipient.address };
}

function unavailableError(status: string): SendErrorRecord {
    return {
        code: status === 'disconnected' ? 'mailbox_disconnected' : 'reconnect_needed',
        message:
            status === 'disconnected'
                ? 'the mailbox is disconnected; the message was not sent'
                : 'the mailbox needs to be connected again; the message was not sent',
        at: new Date().toISOString(),
    };
}

function gmailError(error: GmailApiError): SendErrorRecord {
    return {
        code: `gmail.${error.reason}`,
        message: `Gmail refused the message (${error.status ?? 'no answer'})`,
        at: new Date().toISOString(),
    };
}

function internalError(): SendErrorRecord {
    return { code: 'internal', message: 'the send failed; it will be retried', at: new Date().toISOString() };
}

function view(row: OutboundRow, threadId: string | null): MailOutboundView {
    const error = row.lastError as SendErrorRecord | null;
    return {
        id: row.id,
        mailboxId: row.mailboxId,
        status: row.status,
        subject: row.subject,
        to: row.toAddresses,
        cc: row.ccAddresses,
        bcc: row.bccAddresses,
        personId: row.personId,
        dealId: row.dealId,
        templateId: row.templateId,
        replyToMessageId: row.replyToMessageId,
        rfc822MessageId: row.rfc822MessageId,
        mailMessageId: row.mailMessageId,
        threadId,
        attempts: row.attempts,
        error: error ? { code: error.code, message: error.message, at: new Date(error.at) } : null,
        createdAt: row.createdAt,
        sentAt: row.sentAt,
    };
}
