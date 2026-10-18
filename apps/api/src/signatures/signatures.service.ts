import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
    SIGNATURE_STARTER,
    type ImportedSignature,
    type MailboxSignatureInput,
    type MailboxSignatureView,
    type RenderedSignature,
    type RichText,
    type SignatureProfileInput,
    type SignatureProfileView,
    type SignatureSettingsInput,
    type SignatureSettingsView,
} from '@bylinecrm/shared';
import { Prisma, type Mailbox } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { ApiException, ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { GMAIL_UNITS } from '../mail-sync/mail-sync.constants';
import { GMAIL_PORT, GmailApiError, type GmailPort } from '../mail-sync/gmail.port';
import { MailSyncService } from '../mail-sync/mail-sync.service';
import { actorOf } from '../records/actor';
import { signatureFromHtml } from './gmail-signature';
import { renderSignature, signatureProblems } from './render-signature';
import {
    bookingLinkOf,
    currentLogo,
    effectiveSignature,
    lockProblems,
    logoView,
    onSlotline,
    readSignatureSettings,
    signableMailbox,
    signatureValues,
    slotlineBase,
} from './signature-store';

type ProfileRow = {
    id: string;
    jobTitle: string | null;
    phone: string | null;
    slotlineUsername: string | null;
    slotlineApiKeyLast4: string | null;
    slotlineEventSlug: string | null;
    slotlineEventTitle: string | null;
    user: { displayName: string | null };
};

const json = (doc: RichText | null) => (doc ? (doc as unknown as Prisma.InputJsonObject) : Prisma.DbNull);

/**
 * Email signatures (#193): the workspace default and an admin's locks, each mailbox's own, the member
 * details its variables read, a preview, and a copy of the mailbox's Gmail signature. A mailbox's
 * signature is its member's to change, or an admin's; a pool mailbox's is an admin's. The signature
 * mail carries is decided where it is rendered (`signature-store`), not here.
 */
@Injectable()
export class SignaturesService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly sync: MailSyncService,
        @Inject(GMAIL_PORT) private readonly gmail: GmailPort,
        @Inject(ENV) private readonly env: Env,
    ) {}

    // ── The workspace's ─────────────────────────────────────────────────────────────────────

    settings(): Promise<SignatureSettingsView> {
        this.current();
        return this.rls.withWorkspace((tx) => this.settingsView(tx));
    }

    async putSettings(input: SignatureSettingsInput): Promise<SignatureSettingsView> {
        const context = this.current();
        if (input.defaultSignature) this.assertInSubset(input.defaultSignature, 'defaultSignature');
        const locks = lockProblems(input.defaultSignature, input.locked, 'defaultSignature');
        if (locks.length) throw new ApiException(422, 'unprocessable', 'a locked pre-fill is missing', locks);
        return this.rls.withWorkspace(async (tx) => {
            const data = {
                defaultSignature: json(input.defaultSignature),
                lockLogo: input.locked.logo,
                lockBookingLink: input.locked.bookingLink,
                updatedBy: actorOf(context) as Prisma.InputJsonObject,
            };
            await tx.workspaceSignatureSettings.upsert({
                where: { workspaceId: context.workspaceId },
                create: { workspaceId: context.workspaceId, ...data },
                update: data,
            });
            return this.settingsView(tx);
        });
    }

    // ── A mailbox's ─────────────────────────────────────────────────────────────────────────

    mailboxSignature(mailboxId: string): Promise<MailboxSignatureView> {
        return this.rls.withWorkspace(async (tx) => {
            const mailbox = await this.signable(tx, mailboxId);
            return this.mailboxView(mailbox, await readSignatureSettings(tx));
        });
    }

    async putMailboxSignature(mailboxId: string, input: MailboxSignatureInput): Promise<MailboxSignatureView> {
        if (input.own) this.assertInSubset(input.own, 'own');
        return this.rls.withWorkspace(async (tx) => {
            const mailbox = await this.signable(tx, mailboxId);
            const settings = await readSignatureSettings(tx);
            const problems = lockProblems(
                effectiveSignature({ signature: input.own, useDefaultSignature: input.useDefault }, settings).effective,
                settings.locked,
                'own',
            );
            let bookingLink = mailbox.bookingLink;
            if (input.bookingLink !== undefined) {
                if (mailbox.purpose !== 'pool' && input.bookingLink !== null) {
                    problems.push({
                        path: 'bookingLink',
                        message: 'a personal mailbox links to its member’s booking page',
                    });
                } else if (input.bookingLink !== null && !onSlotline(await slotlineBase(tx), input.bookingLink)) {
                    problems.push({ path: 'bookingLink', message: 'a booking link is a page on the Slotline site' });
                }
                bookingLink = input.bookingLink;
            }
            if (problems.length)
                throw new ApiException(422, 'unprocessable', 'the signature cannot be saved', problems);
            const saved = await tx.mailbox.update({
                where: { id: mailbox.id },
                data: { signature: json(input.own), useDefaultSignature: input.useDefault, bookingLink },
            });
            return this.mailboxView(saved, settings);
        });
    }

    /**
     * The mailbox's Gmail signature as a draft (#193): read from Gmail first — outside any transaction —
     * and converted to the signature subset. Nothing is saved: the member saves the draft, and from then
     * on the CRM's copy is the one used.
     */
    async importFromGmail(mailboxId: string): Promise<ImportedSignature> {
        const mailbox = await this.rls.withWorkspace((tx) => this.signable(tx, mailboxId));
        if (mailbox.status !== 'connected') {
            throw new ApiException(
                409,
                'conflict',
                'the mailbox is not connected; reconnect it to import its signature',
            );
        }
        let list;
        try {
            list = await this.sync.gmailRequest(mailbox, GMAIL_UNITS.listSendAs, {}, (token) =>
                this.gmail.listSendAs(token),
            );
        } catch (error) {
            if (!(error instanceof GmailApiError)) throw error;
            throw new ApiException(409, 'conflict', `Gmail did not give the signature: ${error.message}`);
        }
        const own =
            list.find((s) => s.sendAsEmail.toLowerCase() === mailbox.email) ?? list.find((s) => s.isPrimary) ?? null;
        return signatureFromHtml(own?.signature ?? '');
    }

    /** A signature as it would read in mail from `mailboxId` (or the caller's, with none named). */
    async preview(input: { signature: RichText; mailboxId?: string | undefined }): Promise<RenderedSignature> {
        const context = this.current();
        this.assertInSubset(input.signature, 'signature');
        return this.rls.withWorkspace(async (tx) => {
            const mailbox = input.mailboxId ? await this.signable(tx, input.mailboxId) : null;
            const values = await signatureValues(tx, this.env.APP_URL, {
                workspaceId: context.workspaceId,
                memberId: mailbox?.ownerMemberId ?? context.memberId,
                mailboxId: mailbox?.id,
            });
            return renderSignature(input.signature, values);
        });
    }

    /**
     * A signature a message carries in place of its mailbox's (#193): inside the subset, and — while an
     * admin has locked a pre-fill — carrying it. `null` (no signature) is refused while anything is locked.
     */
    async assertMessageSignature(signature: RichText | null): Promise<void> {
        if (signature) this.assertInSubset(signature, 'signature');
        const { locked } = await this.rls.withWorkspace((tx) => readSignatureSettings(tx));
        const problems = lockProblems(signature, locked, 'signature');
        if (problems.length) throw new ApiException(422, 'unprocessable', 'a locked pre-fill is missing', problems);
    }

    // ── A member's details ──────────────────────────────────────────────────────────────────

    profile(memberId: string): Promise<SignatureProfileView> {
        this.assertSelfOrAdmin(memberId);
        return this.rls.withWorkspace(async (tx) => this.profileView(tx, await this.member(tx, memberId)));
    }

    putProfile(memberId: string, input: SignatureProfileInput): Promise<SignatureProfileView> {
        this.assertSelfOrAdmin(memberId);
        return this.rls.withWorkspace(async (tx) => {
            const member = await this.member(tx, memberId);
            // With a Slotline key the username is the one Slotline gave for it (#196), never typed over.
            if (member.slotlineApiKeyCiphertext && input.slotlineUsername !== member.slotlineUsername) {
                throw new ApiException(422, 'unprocessable', 'the username comes from the Slotline key', [
                    { path: 'slotlineUsername', message: 'set by the Slotline account the key belongs to' },
                ]);
            }
            const saved = await tx.workspaceMember.update({
                where: { id: memberId },
                data: { jobTitle: input.jobTitle, phone: input.phone, slotlineUsername: input.slotlineUsername },
                include: { user: { select: { displayName: true } } },
            });
            return this.profileView(tx, saved);
        });
    }

    /** Every current member's details, by name — an admin's view, to set a member's booking link for them. */
    profiles(): Promise<SignatureProfileView[]> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const members = await tx.workspaceMember.findMany({
                where: { leftAt: null },
                include: { user: { select: { displayName: true } } },
                orderBy: { createdAt: 'asc' },
            });
            const base = await slotlineBase(tx);
            return members.map((m) => this.profileOf(m, base));
        });
    }

    // ── Internals ───────────────────────────────────────────────────────────────────────────

    private async settingsView(tx: WorkspaceClient): Promise<SignatureSettingsView> {
        const settings = await readSignatureSettings(tx);
        const logo = await currentLogo(tx);
        return {
            ...settings,
            logo: logo ? logoView(this.env.APP_URL, logo) : null,
            starter: settings.defaultSignature ?? SIGNATURE_STARTER,
        };
    }

    private mailboxView(
        mailbox: Mailbox,
        settings: Awaited<ReturnType<typeof readSignatureSettings>>,
    ): MailboxSignatureView {
        return {
            mailboxId: mailbox.id,
            own: (mailbox.signature as RichText | null) ?? null,
            useDefault: mailbox.useDefaultSignature,
            ...effectiveSignature(mailbox, settings),
            bookingLink: mailbox.purpose === 'pool' ? mailbox.bookingLink : null,
            locked: settings.locked,
        };
    }

    private async profileView(tx: WorkspaceClient, member: ProfileRow): Promise<SignatureProfileView> {
        return this.profileOf(member, await slotlineBase(tx));
    }

    private profileOf(member: ProfileRow, base: string | null): SignatureProfileView {
        return {
            memberId: member.id,
            name: member.user.displayName,
            jobTitle: member.jobTitle,
            phone: member.phone,
            slotlineUsername: member.slotlineUsername,
            bookingLink: bookingLinkOf(base, member.slotlineUsername, member.slotlineEventSlug),
            slotlineConfigured: base !== null,
            slotlineKey: member.slotlineApiKeyLast4 ? { last4: member.slotlineApiKeyLast4 } : null,
            slotlineEvent:
                member.slotlineEventSlug && member.slotlineEventTitle
                    ? { slug: member.slotlineEventSlug, title: member.slotlineEventTitle }
                    : null,
        };
    }

    private signable(tx: WorkspaceClient, mailboxId: string): Promise<Mailbox> {
        return signableMailbox(tx, this.current(), mailboxId);
    }

    private async member(tx: WorkspaceClient, memberId: string) {
        const member = await tx.workspaceMember.findFirst({
            where: { id: memberId, leftAt: null },
            include: { user: { select: { displayName: true } } },
        });
        if (!member) throw new NotFoundException('member not found');
        return member;
    }

    private assertSelfOrAdmin(memberId: string): void {
        const context = this.current();
        if (context.memberId !== memberId && !this.isAdmin(context)) {
            throw new ApiException(403, 'forbidden', 'a member’s signature details are theirs, or an admin’s');
        }
    }

    private assertInSubset(signature: RichText, field: string): void {
        const problems = signatureProblems(signature, field);
        if (problems.length) throw new ValidationFailed('the signature is not valid', problems);
    }

    private isAdmin(context: WorkspaceRunContext): boolean {
        return context.capabilities.has('workspace:admin');
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('SignaturesService is used inside a workspace scope');
        return context;
    }
}
