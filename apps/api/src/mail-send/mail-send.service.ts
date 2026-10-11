import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
    MAIL_SEND_HORIZON_DAYS,
    MAIL_SEND_MIN_LEAD_SECONDS,
    type DomainEvent,
    type Emails,
    type RichText,
} from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, StateConflict, ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { MailboxUnavailable } from '../mail-accounts/mailbox-tokens.service';
import { MailboxesService } from '../mail-accounts/mailboxes.service';
import { GMAIL_PORT, GmailApiError, type GmailPort, type GmailSent } from '../mail-sync/gmail.port';
import { GMAIL_UNITS } from '../mail-sync/mail-sync.constants';
import { MailSyncService } from '../mail-sync/mail-sync.service';
import type { RetryOptions } from '../mail-sync/retry';
import { actorOf } from '../records/actor';
import { paginate } from '../records/list-query';
import { recordWhere } from '../records/record-scope';
import { RenderService } from '../templates/render.service';
import { withUnsubscribeUrl } from '../templates/render/compose';
import { TemplatesService } from '../templates/templates.service';
import { UnsubscribeService } from '../suppression/unsubscribe.service';
import { afterCommit } from '../infra/transaction-scope';
import { RolesService } from '../workspace/roles.service';
import {
    MAIL_CRM_ID_HEADER,
    MAIL_SEND_DEDUPE_MAX_CANDIDATES,
    MAIL_SEND_DEDUPE_SKEW_MS,
    MAIL_SEND_EARLY_TOLERANCE_MS,
    MAIL_SEND_QUEUE,
    MAIL_SEND_STALE_MS,
} from './mail-send.constants';
import type { MailSendJob } from './mail-send.workers';
import { buildMime, newMessageId, replySubject, type MimeAddress } from './mime';
import type { MailOutboundView, MailScheduledPage, MailSendAccepted } from './responses';
import { PoolRefusal, SendingPoolService } from '../sending-pool/sending-pool.service';
import { RecipientSuppressed } from '../suppression/suppression.service';
import { SendPolicy, type RecipientField, type SendRecipient } from './send-policy';

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
    /** Send later (P2-5): ISO 8601 with an offset. Absent: send now. */
    sendAt?: string | undefined;
    /** The sender's IANA zone, echoed back; never used to compute `sendAt`. */
    timeZone?: string | undefined;
}

/** What a scheduled send was asked to be: the request without its timing, kept to build it again later. */
type PersonalRequest = Omit<SendInput, 'sendAt' | 'timeZone'>;
type StoredRequest = PersonalRequest | OutreachRequest;

/**
 * A sequence step's send (P3-3), as stored: built at its time from the pool mailbox, the person and
 * the step's **outreach** template, as the mailbox's owner with the workspace-wide scope a sequence has
 * — with the outreach footer and the recipient's one-click unsubscribe (FR-CRMS-7).
 */
export interface OutreachRequest {
    kind: 'outreach';
    mailboxId: string;
    personId: string;
    dealId?: string | undefined;
    templateId: string;
    replyToMessageId?: string | undefined;
    enrolmentId: string;
    stepId: string;
}

/** What a sequence asks for when it schedules a step's send. */
export interface ScheduleOutreachInput {
    workspaceId: string;
    mailboxId: string;
    personId: string;
    dealId: string | null;
    templateId: string;
    replyToMessageId: string | null;
    sendAt: Date;
    enrolmentId: string;
    stepId: string;
}

/** Why the last attempt failed, as kept on the row. Never a token or a raw Google body. */
interface SendErrorRecord {
    code: string;
    message: string;
    at: string;
    /** For `unsendable`: the variables that had no value. */
    fields?: string[];
}

/** How a delivery ended: sent (now, or found already sent), failed for good, cancelled, or nothing to do. */
export type DeliveryOutcome = 'sent' | 'already_sent' | 'failed' | 'cancelled' | 'skipped';

/**
 * A scheduled send's job fired before the row's `sendAt` (the send was moved later after its job
 * was set). The worker puts the job back to wait `dueInMs`; nothing was sent or changed.
 */
export class SendNotDue extends Error {
    constructor(readonly dueInMs: number) {
        super(`the send is due in ${dueInMs} ms`);
        this.name = 'SendNotDue';
    }
}

/**
 * A render with a variable that has no value. `422` at the request; at a scheduled send's time it
 * fails the send as `unsendable`, naming the variables — never a partial send.
 */
class Unsendable extends ApiException {
    constructor(readonly missing: readonly string[]) {
        super(
            422,
            'unprocessable',
            `these variables have no value for this person: ${missing.join(', ')}`,
            missing.map((path) => ({ path, message: 'has no value' })),
        );
    }
}

/** A message built and checked, ready to store: the outcome of `prepare`. */
interface Prepared {
    mailboxId: string;
    memberId: string;
    recipients: { to: SendRecipient[]; cc: SendRecipient[]; bcc: SendRecipient[] };
    parentId: string | null;
    subject: string;
    mime: string;
}

/**
 * Sending (P2-3, FR-CRMS-2/3): a member sends from their own connected personal mailbox, through
 * Gmail, as a queued job.
 *
 * `compose` (the request) decides everything about the message and stores it, built: who it is
 * from and to, what it says (a template, or a subject and body, rendered through the template
 * renderer — one path; a render with an empty variable is refused, never sent blank), and how it
 * threads (a reply carries `In-Reply-To` / `References` and goes into the parent's Gmail thread).
 * Every send passes `SendPolicy` — at the request, at a scheduled send's time, and before every
 * delivery attempt, so a recipient suppressed meanwhile (P3-1) is never sent to.
 *
 * `deliver` (the job) sends the stored MIME. Gmail's answer to a `5xx` or a timeout does not say
 * whether the message went, so before every retry — and on a delivery after an attempt that
 * started — it looks in the mailbox's sent mail for our `X-BylineCRM-Id` header first (Gmail
 * replaces the Message-ID we set, so that cannot be searched for — #87); a message Gmail already
 * has is recorded, never sent again. A sent message is stored through mail sync's one writer, which
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
        private readonly roles: RolesService,
        private readonly events: DomainEvents,
        private readonly pool: SendingPoolService,
        private readonly unsubscribes: UnsubscribeService,
        @Inject(GMAIL_PORT) private readonly gmail: GmailPort,
        @InjectQueue(MAIL_SEND_QUEUE) private readonly queue: Queue,
    ) {}

    // ── The request: decide, build, store, queue (or schedule) ─────────────────────────────

    /**
     * A send now builds the message and queues it. A send later (`sendAt`, P2-5) runs the same checks
     * now — so a sender learns at once what would refuse it — but stores what was asked, not what was
     * built: at `sendAt` the job builds and checks it again, as the sender's role, the mailbox and
     * the person stand then.
     */
    async compose(input: SendInput): Promise<MailSendAccepted> {
        const context = this.current();
        const sendAt = input.sendAt === undefined ? null : scheduledTime(input.sendAt);
        // The send's id is fixed before the message is built: the MIME carries it (X-BylineCRM-Id).
        const id = randomUUID();
        const rfc822MessageId = newMessageId();
        const prepared = await this.prepare(input, { id, rfc822MessageId });

        const row = await this.rls.withWorkspace(async (tx) => {
            const created = await tx.mailOutbound.create({
                data: {
                    id,
                    workspaceId: context.workspaceId,
                    mailboxId: prepared.mailboxId,
                    senderMemberId: prepared.memberId,
                    personId: input.personId,
                    dealId: input.dealId ?? null,
                    templateId: input.templateId ?? null,
                    replyToMessageId: prepared.parentId,
                    rfc822MessageId,
                    ...addressesOf(prepared),
                    subject: prepared.subject,
                    ...(sendAt
                        ? {
                              status: 'scheduled' as const,
                              mime: null,
                              sendAt,
                              senderTimeZone: input.timeZone ?? null,
                              request: storedRequest(input) as unknown as Prisma.InputJsonValue,
                          }
                        : { mime: prepared.mime }),
                },
            });
            if (sendAt) await this.announce(tx, 'email.scheduled', context, created.id);
            return created;
        });
        const job: MailSendJob = { workspaceId: context.workspaceId, messageId: row.id };
        await this.queue.add('send', job, {
            jobId: row.id,
            ...(sendAt ? { delay: Math.max(0, sendAt.getTime() - Date.now()) } : {}),
        });
        return {
            messageId: row.id,
            status: sendAt ? 'scheduled' : 'queued',
            sendAt,
            senderTimeZone: row.senderTimeZone,
            recipientTimeZone: null,
        };
    }

    /**
     * Every check a send passes, and the message built — one path for a send now, for a scheduled
     * send at its request, and for that send again at its time. Runs in the caller's workspace scope
     * (a request's, or the one a scheduled send's job opens for its sender).
     */
    private prepare(input: StoredRequest, send: { id: string; rfc822MessageId: string }): Promise<Prepared> {
        return 'kind' in input && input.kind === 'outreach'
            ? this.prepareOutreach(input, send)
            : this.preparePersonal(input as PersonalRequest, send);
    }

    /** A member's own send from their personal mailbox (P2-3). */
    private async preparePersonal(
        input: PersonalRequest,
        send: { id: string; rfc822MessageId: string },
    ): Promise<Prepared> {
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
            const resolve = (list: RecipientInput[] | undefined, field: RecipientField) =>
                resolveRecipients(tx, context, list ?? [], field);
            const to = input.to ? await resolve(input.to, 'to') : [primaryOf(person, 'personId', 'to')];
            const member = await tx.workspaceMember.findUniqueOrThrow({
                where: { id: memberId },
                // The person's display name (P1-UI-10): one per person, read wherever a member is named.
                select: { user: { select: { displayName: true } } },
            });
            let parentRow: Prisma.MailMessageGetPayload<object> | null = null;
            if (input.replyToMessageId) {
                parentRow = await tx.mailMessage.findUnique({ where: { id: input.replyToMessageId } });
                if (!parentRow) throw new NotFoundException('message not found');
                // A message is the workspace's; the sending mailbox must hold a copy of it (#107).
                const held = await tx.mailMessageCopy.count({
                    where: { messageId: parentRow.id, mailboxId: mailbox.id },
                });
                if (held === 0) {
                    throw new ValidationFailed('a reply goes from a mailbox the message is in', [
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
        if (!rendered.sendable) throw new Unsendable(rendered.missing);
        // A reply with no subject of its own takes the parent's, as written — never rendered, so
        // braces in someone else's subject are not variables.
        const subject =
            parent && !input.templateId && (input.subject === undefined || input.subject === '')
                ? replySubject(parent.subject)
                : rendered.subject;

        await this.policy.assertSendable(context.workspaceId, [...recipients.to, ...recipients.cc, ...recipients.bcc]);

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
            messageId: send.rfc822MessageId,
            crmId: send.id,
            inReplyTo: parent?.rfc822MessageId ?? null,
            references,
            date: new Date(),
        });
        return { mailboxId: mailbox.id, memberId, recipients, parentId: parent?.id ?? null, subject, mime };
    }

    /**
     * A sequence step's send, built at its time (P3-3): from the pool mailbox, to the person's primary
     * address, from the step's outreach template rendered with the outreach footer and the workspace's
     * postal address, with the recipient's one-click unsubscribe — a token per (recipient, send) — in
     * `List-Unsubscribe` and in the footer's link (FR-CRMS-7). The same checks as any send: the
     * mailbox's state, every variable filled, `SendPolicy`.
     */
    private async prepareOutreach(
        input: OutreachRequest,
        send: { id: string; rfc822MessageId: string },
    ): Promise<Prepared> {
        const context = this.current();
        const memberId = context.memberId!;
        const mailbox = await this.mailboxes.get(input.mailboxId);
        if (mailbox.purpose !== 'pool') {
            throw new ApiException(403, 'forbidden', 'a sequence sends only from the sending pool');
        }
        if (mailbox.status !== 'connected') throw new MailboxUnavailable(mailbox.status);

        const { to, sender, parent } = await this.rls.withWorkspace(async (tx) => {
            const person = await tx.person.findFirst({ where: { id: input.personId, deletedAt: null } });
            if (!person) throw new NotFoundException('person not found');
            const member = await tx.workspaceMember.findUniqueOrThrow({
                where: { id: memberId },
                select: { user: { select: { displayName: true } } },
            });
            const parentRow = input.replyToMessageId
                ? await tx.mailMessage.findFirst({
                      where: { id: input.replyToMessageId, copies: { some: { mailboxId: mailbox.id } } },
                  })
                : null;
            return { to: primaryOf(person, 'personId', 'to'), sender: member.user.displayName, parent: parentRow };
        });

        const template = await this.templates.get(input.templateId);
        if (template.kind !== 'outreach') {
            throw new ApiException(422, 'unprocessable', 'a sequence sends outreach templates only', [
                { path: 'templateId', message: 'not an outreach template' },
            ]);
        }
        const rendered = await this.renderer.render(
            { kind: 'outreach', subject: template.subject, body: template.body },
            { personId: input.personId, dealId: input.dealId, senderMemberId: memberId },
        );
        if (!rendered.sendable) throw new Unsendable(rendered.missing);
        const subject = parent && template.subject.trim() === '' ? replySubject(parent.subject) : rendered.subject;

        await this.policy.assertSendable(context.workspaceId, [to]);
        const link = await this.unsubscribes.issue(context.workspaceId, {
            address: to.address,
            personId: input.personId,
            outboundId: send.id,
        });
        const email = withUnsubscribeUrl(rendered, link.pageUrl);
        const references = parent
            ? [...parent.references, ...(parent.rfc822MessageId ? [parent.rfc822MessageId] : [])]
            : [];
        const mime = buildMime({
            from: { address: mailbox.email, name: sender },
            to: [toMime(to)],
            cc: [],
            bcc: [],
            subject,
            text: email.text,
            html: email.html,
            messageId: send.rfc822MessageId,
            crmId: send.id,
            inReplyTo: parent?.rfc822MessageId ?? null,
            references,
            listUnsubscribe: { url: link.oneClickUrl },
            date: new Date(),
        });
        return {
            mailboxId: mailbox.id,
            memberId,
            recipients: { to: [to], cc: [], bcc: [] },
            parentId: parent?.id ?? null,
            subject,
            mime,
        };
    }

    /**
     * Schedules a sequence step's send (P3-3) inside the caller's transaction — the one that moves the
     * enrolment to wait for it — so the two exist together or not at all. Stored as a scheduled send
     * whose request is outreach: it is built and checked at `sendAt` (`activate`), from the pool
     * mailbox, as the mailbox's owner. Its job is added once the transaction commits.
     */
    async scheduleOutreach(tx: WorkspaceClient, input: ScheduleOutreachInput): Promise<string> {
        const mailbox = await tx.mailbox.findUniqueOrThrow({ where: { id: input.mailboxId } });
        const person = await tx.person.findUniqueOrThrow({ where: { id: input.personId } });
        const request: OutreachRequest = {
            kind: 'outreach',
            mailboxId: input.mailboxId,
            personId: input.personId,
            ...(input.dealId ? { dealId: input.dealId } : {}),
            templateId: input.templateId,
            ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
            enrolmentId: input.enrolmentId,
            stepId: input.stepId,
        };
        const created = await tx.mailOutbound.create({
            data: {
                workspaceId: input.workspaceId,
                mailboxId: mailbox.id,
                senderMemberId: mailbox.ownerMemberId,
                personId: input.personId,
                dealId: input.dealId,
                templateId: input.templateId,
                replyToMessageId: input.replyToMessageId,
                rfc822MessageId: newMessageId(),
                toAddresses: [primaryOf(person, 'personId', 'to').address],
                subject: '',
                status: 'scheduled',
                mime: null,
                sendAt: input.sendAt,
                request: request as unknown as Prisma.InputJsonValue,
                sequenceEnrolmentId: input.enrolmentId,
                sequenceStepId: input.stepId,
            },
        });
        await this.events.record(tx, {
            type: 'email.scheduled',
            object: 'email',
            workspaceId: input.workspaceId,
            actor: { kind: 'system', id: null },
            occurredAt: new Date().toISOString(),
            recordId: created.id,
        } as DomainEvent);
        const job: MailSendJob = { workspaceId: input.workspaceId, messageId: created.id };
        const delay = Math.max(0, input.sendAt.getTime() - Date.now());
        afterCommit('MailSendService.scheduleOutreach', () => {
            this.queue.add('send', job, { jobId: created.id, delay }).catch((error: unknown) => {
                // The send sweep gives a scheduled send without a job one; nothing is lost.
                this.logger.warn(
                    `outreach send ${created.id}: job not added (${error instanceof Error ? error.message : String(error)}); the sweep will`,
                );
            });
        });
        return created.id;
    }

    /**
     * Calls off a sequence step's send that has not gone yet (P3-3: its enrolment stopped), in the
     * caller's transaction. Only a `scheduled` send — once it is being built or sent it is left to finish.
     * The same change and event as a member's cancel; its job is dropped after commit.
     */
    async cancelForSequence(tx: WorkspaceClient, workspaceId: string, id: string): Promise<void> {
        const result = await tx.mailOutbound.updateMany({
            where: { id, status: 'scheduled' },
            data: { status: 'cancelled', cancelledAt: new Date() },
        });
        if (result.count === 0) return;
        await this.events.record(tx, {
            type: 'email.cancelled',
            object: 'email',
            workspaceId,
            actor: { kind: 'system', id: null },
            occurredAt: new Date().toISOString(),
            recordId: id,
        } as DomainEvent);
        afterCommit('MailSendService.cancelForSequence', () => void this.dropJob(id));
    }

    // ── Scheduled sends: list, cancel, move ──────────────────────────────────────────────────

    /** The caller's scheduled sends (an admin's: everyone's), soonest first. */
    async scheduled(limit: number, cursor: string | undefined): Promise<MailScheduledPage> {
        const context = this.current();
        const mine = !context.capabilities.has('workspace:admin');
        if (mine && !context.memberId) return { items: [], nextCursor: null };
        return this.rls.withWorkspace(async (tx) => {
            const page = await paginate(limit, cursor, (args) =>
                tx.mailOutbound.findMany({
                    where: { status: 'scheduled', ...(mine ? { senderMemberId: context.memberId! } : {}) },
                    orderBy: [{ sendAt: 'asc' }, { id: 'asc' }],
                    ...args,
                }),
            );
            return { items: page.items.map((row) => view(row, null)), nextCursor: page.nextCursor };
        });
    }

    /**
     * Calls a scheduled send off: its sender or an admin, while it is `scheduled`. Cancelling one
     * already cancelled answers as it stands; one that has started (or gone) is a `409`. The row is
     * changed first and the job removed after — a job that fires in between finds the row cancelled
     * and sends nothing.
     */
    async cancel(id: string): Promise<MailOutboundView> {
        const context = this.current();
        const row = await this.ownSend(id);
        if (row.status === 'cancelled') return view(row, null);
        if (row.status !== 'scheduled') throw notScheduled(row.status);
        const changed = await this.rls.withWorkspace(async (tx) => {
            const result = await tx.mailOutbound.updateMany({
                where: { id, status: 'scheduled' },
                data: { status: 'cancelled', cancelledAt: new Date() },
            });
            if (result.count > 0) await this.announce(tx, 'email.cancelled', context, id);
            return result;
        });
        if (changed.count === 0) {
            const now = await this.ownSend(id);
            if (now.status === 'cancelled') return view(now, null);
            throw notScheduled(now.status);
        }
        await this.dropJob(id);
        return view(await this.ownSend(id), null);
    }

    /**
     * Moves a scheduled send to another time (its sender or an admin, while `scheduled`). The row
     * is the truth and the job only the trigger: the delay is changed when the job waits, the job is
     * set again when it is gone, and a job already firing finds the new `sendAt` and waits again.
     */
    async reschedule(id: string, input: { sendAt: string; timeZone?: string | undefined }): Promise<MailOutboundView> {
        const sendAt = scheduledTime(input.sendAt);
        const row = await this.ownSend(id);
        if (row.status !== 'scheduled') throw notScheduled(row.status);
        const changed = await this.rls.withWorkspace((tx) =>
            tx.mailOutbound.updateMany({
                where: { id, status: 'scheduled' },
                data: { sendAt, ...(input.timeZone !== undefined ? { senderTimeZone: input.timeZone } : {}) },
            }),
        );
        if (changed.count === 0) throw notScheduled((await this.ownSend(id)).status);
        await this.setJob(row.workspaceId, id, sendAt);
        return view(await this.ownSend(id), null);
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
    async deliver(
        workspaceId: string,
        id: string,
        retry: RetryOptions = {},
        now = Date.now(),
    ): Promise<DeliveryOutcome> {
        const read = () => this.rls.withWorkspace(workspaceId, (tx) => tx.mailOutbound.findUnique({ where: { id } }));
        let row = await read();
        if (!row || row.status === 'sent' || row.status === 'failed') return 'skipped';
        if (row.status === 'cancelled') return 'cancelled';
        if (row.status === 'scheduled') {
            const activated = await this.activate(workspaceId, row, now);
            if (activated !== 'ready') return activated;
            row = await read();
            if (!row || row.status !== 'queued') return row?.status === 'cancelled' ? 'cancelled' : 'skipped';
        }
        if (row.mime === null) return 'skipped';
        const mime = row.mime;
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: row.mailboxId } }),
        );
        if (!mailbox) return 'skipped';
        if (mailbox.status !== 'connected') {
            await this.markFailed(workspaceId, id, unavailableError(mailbox.status));
            return 'failed';
        }

        const startedBefore = row.status === 'sending';
        // The pool's gate (P3-2) and the move to `sending` are one step, with the mailbox locked: a
        // pool send is counted against its mailbox's allowance as it is claimed. A refusal fails it.
        try {
            await this.rls.withWorkspace(workspaceId, async (tx) => {
                await this.pool.claim(tx, mailbox.id, id, startedBefore);
                await tx.mailOutbound.update({
                    where: { id },
                    data: { status: 'sending', attempts: { increment: 1 }, lastAttemptAt: new Date() },
                });
            });
        } catch (error) {
            if (!(error instanceof PoolRefusal)) throw error;
            await this.markFailed(workspaceId, id, refusalRecord(error, Date.now()));
            return 'failed';
        }
        const threadId = await this.parentThread(workspaceId, row);

        let sent: { message: GmailSent; found: boolean };
        try {
            let attempt = 0;
            sent = await this.sync.gmailRequest(mailbox, GMAIL_UNITS.send, retry, async (token) => {
                attempt += 1;
                // An attempt that may have reached Gmail is looked for before anything is sent again.
                if (attempt > 1 || startedBefore) {
                    const found = await this.findSent(token, mailbox.id, row);
                    if (found) return { message: found, found: true };
                }
                // Checked before every attempt: an address suppressed while the send waited, or
                // between two attempts, is not sent to (P3-1). A message Gmail already has was
                // found above and is recorded as sent, because it was.
                await this.policy.assertSendable(workspaceId, storedRecipients(row));
                const message = await this.gmail.send(token, { raw: mime, ...(threadId ? { threadId } : {}) });
                return { message, found: false };
            });
        } catch (error) {
            if (error instanceof MailboxUnavailable) {
                await this.markFailed(workspaceId, id, unavailableError(error.mailboxStatus));
                return 'failed';
            }
            if (error instanceof RecipientSuppressed) {
                await this.markFailed(workspaceId, id, refusalRecord(error, Date.now()));
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

    /**
     * A scheduled send's time has come: build and check it again, as its sender's role, the mailbox
     * and the person stand now. Any refusal fails it — `unsendable` (naming the variables),
     * `forbidden`, the mailbox's state, `not_found` — never a partial send. A send whose time passed
     * long ago is failed as `stale`. The row moves `scheduled` → `queued` only if nobody cancelled it
     * meanwhile.
     */
    private async activate(
        workspaceId: string,
        row: OutboundRow,
        now: number,
    ): Promise<'ready' | 'failed' | 'cancelled' | 'skipped'> {
        const dueAt = row.sendAt!.getTime();
        if (dueAt - now > MAIL_SEND_EARLY_TOLERANCE_MS) throw new SendNotDue(dueAt - now);
        if (now - dueAt > MAIL_SEND_STALE_MS) {
            return this.failScheduled(workspaceId, row.id, {
                code: 'stale',
                message: `its time (${new Date(dueAt).toISOString()}) passed more than a day ago while nothing could send it; it was not sent`,
                at: new Date(now).toISOString(),
            });
        }
        const outreach = (row.request as { kind?: string } | null)?.kind === 'outreach';
        const sender = outreach
            ? await this.outreachContext(workspaceId, row.senderMemberId)
            : await this.senderContext(workspaceId, row.senderMemberId);
        if ('refusal' in sender) {
            return this.failScheduled(workspaceId, row.id, {
                code: 'forbidden',
                message: sender.refusal,
                at: new Date(now).toISOString(),
            });
        }
        let prepared: Prepared;
        try {
            prepared = await this.context.run(sender.context, () =>
                this.prepare(row.request as unknown as StoredRequest, {
                    id: row.id,
                    rfc822MessageId: row.rfc822MessageId,
                }),
            );
        } catch (error) {
            if (!(error instanceof HttpException)) throw error;
            return this.failScheduled(workspaceId, row.id, refusalRecord(error, now));
        }
        const changed = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailOutbound.updateMany({
                where: { id: row.id, status: 'scheduled' },
                data: {
                    status: 'queued',
                    mime: prepared.mime,
                    subject: prepared.subject,
                    replyToMessageId: prepared.parentId,
                    ...addressesOf(prepared),
                },
            }),
        );
        return changed.count === 1 ? 'ready' : this.lostTo(workspaceId, row.id);
    }

    /**
     * Another hand moved a `scheduled` row first: a cancel (the send stands cancelled), or a second
     * delivery of the same send (it is sending it — this one does nothing).
     */
    private async lostTo(workspaceId: string, id: string): Promise<'cancelled' | 'skipped'> {
        const row = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailOutbound.findUnique({ where: { id }, select: { status: true } }),
        );
        return row?.status === 'cancelled' ? 'cancelled' : 'skipped';
    }

    /** Fails a send still `scheduled` (a cancel, or another delivery, that got there first wins). */
    private async failScheduled(
        workspaceId: string,
        id: string,
        error: SendErrorRecord,
    ): Promise<'failed' | 'cancelled' | 'skipped'> {
        const changed = await this.rls.withWorkspace(workspaceId, async (tx) => {
            const result = await tx.mailOutbound.updateMany({
                where: { id, status: 'scheduled' },
                data: { status: 'failed', lastError: error as unknown as Prisma.InputJsonValue },
            });
            if (result.count === 1) await this.announceFailure(tx, workspaceId, id, error);
            return result;
        });
        return changed.count === 1 ? 'failed' : this.lostTo(workspaceId, id);
    }

    /**
     * The workspace scope a scheduled send is built in: its sender as they are now — still a member,
     * still allowed to send mail, with their role's record scope. Who they were when they scheduled
     * it does not count.
     */
    private async senderContext(
        workspaceId: string,
        memberId: string,
    ): Promise<{ context: WorkspaceRunContext } | { refusal: string }> {
        const member = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.workspaceMember.findUnique({ where: { id: memberId }, select: { userId: true, roleId: true } }),
        );
        if (!member) return { refusal: 'the sender is no longer a member of this workspace; it was not sent' };
        const access = await this.roles.access(workspaceId, member.roleId);
        if (!access || !access.capabilities.has('email:send')) {
            return { refusal: 'the sender may no longer send mail; it was not sent' };
        }
        return {
            context: {
                workspaceId,
                userId: member.userId,
                memberId,
                roleId: access.roleId,
                roleName: access.roleName,
                capabilities: access.capabilities,
                ...(access.recordScope === 'own' ? { ownerScopeMemberId: memberId } : {}),
            },
        };
    }

    /**
     * The scope a sequence step's send is built in (P3-3): the pool mailbox's owner, with the
     * workspace-wide record scope a sequence has — a sequence is the workspace's, not a member's, so a
     * role scoped to its own records does not narrow it.
     */
    private async outreachContext(
        workspaceId: string,
        memberId: string,
    ): Promise<{ context: WorkspaceRunContext } | { refusal: string }> {
        const member = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.workspaceMember.findUnique({ where: { id: memberId }, select: { userId: true, roleId: true } }),
        );
        if (!member)
            return { refusal: "the pool mailbox's owner is no longer a member of this workspace; it was not sent" };
        const access = await this.roles.access(workspaceId, member.roleId);
        if (!access) return { refusal: "the pool mailbox's owner has no role; it was not sent" };
        return {
            context: {
                workspaceId,
                userId: member.userId,
                memberId,
                roleId: access.roleId,
                roleName: access.roleName,
                capabilities: access.capabilities,
            },
        };
    }

    /** A send as its sender (or an admin) may change it; `404` for anyone else. */
    private ownSend(id: string): Promise<OutboundRow> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.mailOutbound.findUnique({ where: { id } });
            if (!row || (!context.capabilities.has('workspace:admin') && row.senderMemberId !== context.memberId)) {
                throw new NotFoundException('message not found');
            }
            return row;
        });
    }

    /** Points the send's one job at `sendAt`: the delay changed while it waits, or the job set again. */
    private async setJob(workspaceId: string, id: string, sendAt: Date): Promise<void> {
        const delay = Math.max(0, sendAt.getTime() - Date.now());
        const job = await this.queue.getJob(id);
        if (job) {
            const state = await job.getState();
            if (state === 'delayed') {
                await job.changeDelay(delay);
                return;
            }
            // A job already running reads the new `sendAt` and waits again (`SendNotDue`).
            if (state === 'active') return;
            await job.remove();
        }
        const data: MailSendJob = { workspaceId, messageId: id };
        await this.queue.add('send', data, { jobId: id, delay });
    }

    /** Removes the send's job; one already running finds the row changed and sends nothing. */
    private async dropJob(id: string): Promise<void> {
        const job = await this.queue.getJob(id);
        if (!job) return;
        try {
            await job.remove();
        } catch (error) {
            this.logger.debug(
                `send ${id}: job not removed (${error instanceof Error ? error.message : String(error)})`,
            );
        }
    }

    /** Records a scheduling event in the transaction that made the change (P1-6). */
    private announce(
        tx: WorkspaceClient,
        type: 'email.scheduled' | 'email.cancelled',
        context: WorkspaceRunContext,
        recordId: string,
    ): Promise<void> {
        return this.events.record(tx, {
            type,
            object: 'email',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId,
        } as DomainEvent);
    }

    /** The Gmail thread a reply goes into: the one the sending mailbox's copy of the parent is in (#107). */
    private async parentThread(workspaceId: string, row: OutboundRow): Promise<string | null> {
        if (!row.replyToMessageId) return null;
        const copy = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailMessageCopy.findFirst({
                where: { messageId: row.replyToMessageId!, mailboxId: row.mailboxId },
                select: { mailboxThread: { select: { providerThreadId: true } } },
            }),
        );
        return copy?.mailboxThread.providerThreadId ?? null;
    }

    /**
     * The message Gmail already has for this send, if it took one whose answer was lost. Gmail
     * replaces the Message-ID we set (#87), so the send is recognised by our own `X-BylineCRM-Id`
     * header: among the mailbox's sent mail to the first recipient since the send was created (less
     * a skew), newest first, at most `MAIL_SEND_DEDUPE_MAX_CANDIDATES`, each read for that header
     * only. Every request counts against the mailbox's quota like any other.
     */
    private async findSent(token: string, mailboxId: string, row: OutboundRow): Promise<GmailSent | null> {
        const to = row.toAddresses[0];
        if (!to) return null;
        const since = Math.floor((row.createdAt.getTime() - MAIL_SEND_DEDUPE_SKEW_MS) / 1000);
        const query = `in:sent to:${to} after:${since}`;
        const wanted = MAIL_CRM_ID_HEADER.toLowerCase();
        let checked = 0;
        let pageToken: string | undefined;
        do {
            await this.sync.chargeQuota(mailboxId, GMAIL_UNITS.listMessages);
            const page = await this.gmail.listMessages(token, { query, ...(pageToken ? { pageToken } : {}) });
            for (const ref of page.messages) {
                if (checked >= MAIL_SEND_DEDUPE_MAX_CANDIDATES) return null;
                checked += 1;
                await this.sync.chargeQuota(mailboxId, GMAIL_UNITS.getMessage);
                const candidate = await this.gmail.getMessageHeaders(token, ref.id, [MAIL_CRM_ID_HEADER]);
                const ours = candidate.headers.some(
                    (h) => h.name.toLowerCase() === wanted && h.value.trim() === row.id,
                );
                if (ours) return { id: candidate.id, threadId: candidate.threadId };
            }
            pageToken = page.nextPageToken ?? undefined;
        } while (pageToken && checked < MAIL_SEND_DEDUPE_MAX_CANDIDATES);
        return null;
    }

    /** Fails a send for good; announced once (`email.failed`), when it becomes failed — not on a re-mark. */
    private async markFailed(workspaceId: string, id: string, error: SendErrorRecord): Promise<void> {
        await this.rls.withWorkspace(workspaceId, async (tx) => {
            const record = error as unknown as Prisma.InputJsonValue;
            const changed = await tx.mailOutbound.updateMany({
                where: { id, status: { in: ['queued', 'sending'] } },
                data: { status: 'failed', lastError: record },
            });
            if (changed.count === 1) await this.announceFailure(tx, workspaceId, id, error);
            else await tx.mailOutbound.updateMany({ where: { id, status: 'failed' }, data: { lastError: record } });
        });
    }

    /** `email.failed` (P3-3), in the transaction that failed the send: what a sequence reads to reschedule, hold or stop its step. */
    private announceFailure(
        tx: WorkspaceClient,
        workspaceId: string,
        id: string,
        error: SendErrorRecord,
    ): Promise<void> {
        return this.events.record(tx, {
            type: 'email.failed',
            object: 'email',
            workspaceId,
            actor: { kind: 'system', id: null },
            occurredAt: new Date().toISOString(),
            recordId: id,
            failure: { outboundId: id, code: error.code, message: error.message },
        } as DomainEvent);
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

/**
 * A scheduled send's time, checked against the clock: at least `MAIL_SEND_MIN_LEAD_SECONDS` away
 * (sooner is a send now) and at most `MAIL_SEND_HORIZON_DAYS` ahead.
 */
function scheduledTime(iso: string, now = Date.now()): Date {
    const at = new Date(iso);
    if (at.getTime() < now + MAIL_SEND_MIN_LEAD_SECONDS * 1000) {
        throw new ValidationFailed('a scheduled send is for later', [
            {
                path: 'sendAt',
                message: `at least ${MAIL_SEND_MIN_LEAD_SECONDS} seconds from now; leave it out to send now`,
            },
        ]);
    }
    if (at.getTime() > now + MAIL_SEND_HORIZON_DAYS * 24 * 60 * 60 * 1000) {
        throw new ValidationFailed('a scheduled send is too far ahead', [
            { path: 'sendAt', message: `at most ${MAIL_SEND_HORIZON_DAYS} days ahead` },
        ]);
    }
    return at;
}

/** What a scheduled send keeps of its request: everything but its timing. */
function storedRequest(input: SendInput): PersonalRequest {
    const { sendAt: _sendAt, timeZone: _timeZone, ...rest } = input;
    return rest;
}

function addressesOf(prepared: Prepared): { toAddresses: string[]; ccAddresses: string[]; bccAddresses: string[] } {
    return {
        toAddresses: prepared.recipients.to.map((r) => r.address),
        ccAddresses: prepared.recipients.cc.map((r) => r.address),
        bccAddresses: prepared.recipients.bcc.map((r) => r.address),
    };
}

function notScheduled(status: string): StateConflict {
    return new StateConflict(`this send is ${status}; only a scheduled send can be moved or cancelled`, { status });
}

/** A refusal at a scheduled send's time, as kept on the row. */
function refusalRecord(error: HttpException, now: number): SendErrorRecord {
    const at = new Date(now).toISOString();
    if (error instanceof Unsendable) {
        return {
            code: 'unsendable',
            message: `these variables had no value when it was due: ${error.missing.join(', ')}; it was not sent`,
            at,
            fields: [...error.missing],
        };
    }
    if (error instanceof MailboxUnavailable) return unavailableError(error.mailboxStatus);
    if (error instanceof ApiException) {
        return {
            code: error.code,
            message: `${error.message}; it was not sent`,
            at,
            ...(error.fieldErrors?.length ? { fields: error.fieldErrors.map((f) => f.path) } : {}),
        };
    }
    const code = error.getStatus() === 404 ? 'not_found' : error.getStatus() === 403 ? 'forbidden' : 'refused';
    return { code, message: `${error.message}; it was not sent`, at };
}

/** The person's primary address as a recipient; `422` when they have none. */
function primaryOf(person: { id: string; emails: unknown }, path: string, field: RecipientField): SendRecipient {
    const primary = (person.emails as Emails | null)?.primary;
    if (!primary) {
        throw new ApiException(422, 'unprocessable', 'this person has no email address', [
            { path, message: 'has no primary email address' },
        ]);
    }
    return { address: primary.toLowerCase(), personId: person.id, field };
}

/** Each recipient as an address: a person by their primary (read under the caller's scope), an address as given. */
async function resolveRecipients(
    tx: Prisma.TransactionClient,
    context: WorkspaceRunContext,
    list: RecipientInput[],
    field: RecipientField,
): Promise<SendRecipient[]> {
    const out: SendRecipient[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
        let recipient: SendRecipient;
        if ('personId' in entry) {
            const person = await tx.person.findFirst({ where: { id: entry.personId, ...recordWhere(context, false) } });
            if (!person) throw new NotFoundException('person not found');
            recipient = primaryOf(person, `${field}.${index}.personId`, field);
        } else {
            recipient = { address: entry.address.toLowerCase(), personId: null, field };
        }
        if (seen.has(recipient.address)) continue;
        seen.add(recipient.address);
        out.push(recipient);
    }
    return out;
}

/** A built send's recipients as stored on its row, each at its field. */
function storedRecipients(row: OutboundRow): SendRecipient[] {
    const at = (field: RecipientField, addresses: string[]) =>
        addresses.map((address) => ({ address, personId: null, field }));
    return [...at('to', row.toAddresses), ...at('cc', row.ccAddresses), ...at('bcc', row.bccAddresses)];
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
        error: error
            ? {
                  code: error.code,
                  message: error.message,
                  at: new Date(error.at),
                  ...(error.fields ? { fields: error.fields } : {}),
              }
            : null,
        sendAt: row.sendAt,
        senderTimeZone: row.senderTimeZone,
        recipientTimeZone: null,
        cancelledAt: row.cancelledAt,
        createdAt: row.createdAt,
        sentAt: row.sentAt,
    };
}
