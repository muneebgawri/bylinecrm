import { Inject, Injectable } from '@nestjs/common';
import { SLOTLINE_USERNAME_PATTERN, type SignatureProfileView, type SlotlineEventTypeView } from '@bylinecrm/shared';
import { SLOTLINE_API_PORT, SlotlineApiError, type SlotlineApiPort } from '../calendar/slotline/slotline-api.port';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { bookingLinkOf, slotlineBase } from './signature-store';
import { SignaturesService } from './signatures.service';

/**
 * A member's own Slotline account (#196): their personal API key — checked with Slotline before it is
 * kept, sealed, shown by its last four only — every event type on that account, hidden ones too, and the
 * one their "Book a quick meeting" opens. The member's alone: not an admin's, not another member's. Every
 * Slotline call runs with no transaction open — read first, call, then write.
 */
@Injectable()
export class SlotlineAccountService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        private readonly signatures: SignaturesService,
        @Inject(SLOTLINE_API_PORT) private readonly api: SlotlineApiPort,
    ) {}

    /** Keeps the key once Slotline accepts it; the username becomes the one Slotline gives for it. */
    async putKey(memberId: string, apiKey: string): Promise<SignatureProfileView> {
        this.assertSelf(memberId);
        const base = await this.rls.withWorkspace((tx) => slotlineBase(tx));
        if (!base) throw notSetUp();
        const { username } = await this.call(() => this.api.me(base, apiKey), 'apiKey');
        if (!SLOTLINE_USERNAME_PATTERN.test(username)) {
            throw new ApiException(409, 'conflict', 'Slotline gave a username a booking link cannot carry');
        }
        await this.rls.withWorkspace(async (tx) => {
            const before = await tx.workspaceMember.findUniqueOrThrow({
                where: { id: memberId },
                select: { slotlineUsername: true },
            });
            await tx.workspaceMember.update({
                where: { id: memberId },
                data: {
                    slotlineApiKeyCiphertext: this.secrets.seal(apiKey),
                    slotlineApiKeyLast4: apiKey.slice(-4),
                    slotlineUsername: username,
                    // Another account's event types are not this one's.
                    ...(before.slotlineUsername === username
                        ? {}
                        : { slotlineEventSlug: null, slotlineEventTitle: null }),
                },
            });
        });
        return this.signatures.profile(memberId);
    }

    /** Forgets the key; the username and the picked event type stay, and so does the link. */
    async removeKey(memberId: string): Promise<void> {
        this.assertSelf(memberId);
        await this.rls.withWorkspace((tx) =>
            tx.workspaceMember.update({
                where: { id: memberId },
                data: { slotlineApiKeyCiphertext: null, slotlineApiKeyLast4: null },
            }),
        );
    }

    async eventTypes(memberId: string): Promise<SlotlineEventTypeView[]> {
        this.assertSelf(memberId);
        const account = await this.account(memberId);
        const list = await this.call(() => this.api.eventTypes(account.base, account.apiKey));
        return list.map((e) => ({ ...e, bookingLink: bookingLinkOf(account.base, account.username, e.slug)! }));
    }

    /** One of the account's event types as it is now on Slotline, or `null` for the member's page. */
    async pickEvent(memberId: string, slug: string | null): Promise<SignatureProfileView> {
        this.assertSelf(memberId);
        let title: string | null = null;
        if (slug !== null) {
            const account = await this.account(memberId);
            const list = await this.call(() => this.api.eventTypes(account.base, account.apiKey));
            const found = list.find((e) => e.slug === slug);
            if (!found) {
                throw new ApiException(422, 'unprocessable', 'not an event type on the Slotline account', [
                    { path: 'slug', message: 'not one of the account’s event types' },
                ]);
            }
            title = found.title;
        }
        await this.rls.withWorkspace((tx) =>
            tx.workspaceMember.update({
                where: { id: memberId },
                data: { slotlineEventSlug: slug, slotlineEventTitle: title },
            }),
        );
        return this.signatures.profile(memberId);
    }

    private async account(memberId: string): Promise<{ base: string; apiKey: string; username: string }> {
        const { base, member } = await this.rls.withWorkspace(async (tx) => ({
            base: await slotlineBase(tx),
            member: await tx.workspaceMember.findUniqueOrThrow({
                where: { id: memberId },
                select: { slotlineApiKeyCiphertext: true, slotlineUsername: true },
            }),
        }));
        if (!base) throw notSetUp();
        if (!member.slotlineApiKeyCiphertext || !member.slotlineUsername) {
            throw new ApiException(409, 'conflict', 'add your Slotline API key to list your event types');
        }
        return { base, apiKey: this.secrets.open(member.slotlineApiKeyCiphertext), username: member.slotlineUsername };
    }

    /** A Slotline call, its failure in the CRM's words: a refused key, or no answer. */
    private async call<T>(request: () => Promise<T>, keyField?: string): Promise<T> {
        try {
            return await request();
        } catch (error) {
            if (!(error instanceof SlotlineApiError)) throw error;
            if (error.refused && keyField) {
                throw new ApiException(422, 'unprocessable', 'Slotline refused the key', [
                    { path: keyField, message: 'Slotline does not accept this key' },
                ]);
            }
            if (error.refused) {
                throw new ApiException(409, 'conflict', 'Slotline refused the saved key; enter it again');
            }
            throw new ApiException(409, 'conflict', `Slotline could not be reached: ${error.message}`);
        }
    }

    private assertSelf(memberId: string): void {
        if (this.current().memberId !== memberId) {
            throw new ApiException(403, 'forbidden', 'a Slotline account is its member’s own');
        }
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('SlotlineAccountService is used inside a workspace scope');
        return context;
    }
}

function notSetUp(): ApiException {
    return new ApiException(409, 'conflict', 'Slotline is not set up: an admin connects it under Settings → Slotline');
}
