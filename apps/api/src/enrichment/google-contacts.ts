import { Inject, Injectable, Logger } from '@nestjs/common';
import {
    GOOGLE_CONTACTS_SCOPE,
    GOOGLE_CONTACTS_SCOPES,
    GOOGLE_OTHER_CONTACTS_SCOPE,
    type EnrichmentFactKey,
    type EnrichmentObject,
} from '@bylinecrm/shared';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { MailboxTokens, MailboxUnavailable } from '../mail-accounts/mailbox-tokens.service';
import { GOOGLE_CONTACTS_MAILBOXES, GOOGLE_CONTACTS_WARM_MS } from './enrichment.constants';
import type { Enricher, EnrichmentFinding, EnrichmentSubject } from './enricher.port';
import {
    GOOGLE_CONTACTS_PORT,
    GoogleContactsError,
    type ContactList,
    type GoogleContactMatch,
    type GoogleContactsPort,
} from './google-contacts.port';

const FACTS: readonly EnrichmentFactKey[] = ['avatar_url'];

/** What a person sees when no member's contacts hold a picture: a normal answer, not a failure. */
export const GOOGLE_CONTACTS_NO_PICTURE = 'No picture in the members’ Google contacts';

/** The pixel size asked of Google's picture server (its URLs end in `=s<px>`), the same as Gravatar's. */
const PICTURE_SIZE = 256;

/**
 * A person's picture from the members' Google contacts (AVATAR-1), ported from BylineAI's avatars: each
 * connected personal mailbox whose grant carries a contacts scope — delegated or the member's own — is
 * asked, the record owner's first, until one holds a real picture for the address. A contact photo is one
 * a colleague saved or Google shows in Gmail, so it outranks Gravatar (rank 2 against 1), as BylineAI
 * asked Google before Gravatar.
 */
@Injectable()
export class GoogleContactsEnricher implements Enricher {
    readonly source = 'google_contacts' as const;
    private readonly logger = new Logger(GoogleContactsEnricher.name);
    /** When each mailbox's list was last warmed (`<mailboxId>:<list>`); see `GoogleContactsPort.search`. */
    private readonly warmed = new Map<string, number>();

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly tokens: MailboxTokens,
        @Inject(GOOGLE_CONTACTS_PORT) private readonly google: GoogleContactsPort,
    ) {}

    facts(object: EnrichmentObject): readonly EnrichmentFactKey[] {
        return object === 'person' ? FACTS : [];
    }

    applies(subject: EnrichmentSubject): boolean {
        return subject.object === 'person' && subject.workspaceId !== undefined && Boolean(subject.person?.email);
    }

    async available(workspaceId: string): Promise<boolean> {
        return (await this.mailboxes(workspaceId, null)).length > 0;
    }

    async enrich(subject: EnrichmentSubject): Promise<EnrichmentFinding[]> {
        const email = subject.person!.email!.trim().toLowerCase();
        const workspaceId = subject.workspaceId!;
        let unanswered: GoogleContactsError | null = null;
        for (const mailbox of await this.mailboxes(workspaceId, subject.person!.ownerId ?? null)) {
            let token: string;
            try {
                token = await this.tokens.getAccessToken(workspaceId, mailbox.id);
            } catch (error) {
                if (error instanceof MailboxUnavailable) continue;
                throw error;
            }
            for (const list of listsFor(mailbox.grantedScopes)) {
                try {
                    const url = pictureFor(await this.search(mailbox.id, token, list, email), email);
                    if (url) return [{ field: 'avatar_url', status: 'answered', value: url, rank: 2 }];
                } catch (error) {
                    if (!(error instanceof GoogleContactsError)) throw error;
                    if (error.notAllowed) {
                        this.logger.warn(`mailbox ${mailbox.id} ${list}: ${error.message}`);
                        continue;
                    }
                    unanswered = error;
                }
            }
        }
        // A mailbox that could not answer (throttled, down) may hold the picture: failed, so it is asked again.
        if (unanswered) throw unanswered;
        return [{ field: 'avatar_url', status: 'no_answer', note: GOOGLE_CONTACTS_NO_PICTURE }];
    }

    private async search(
        mailboxId: string,
        token: string,
        list: ContactList,
        email: string,
    ): Promise<GoogleContactMatch[]> {
        const key = `${mailboxId}:${list}`;
        const at = this.warmed.get(key);
        if (at === undefined || Date.now() - at > GOOGLE_CONTACTS_WARM_MS) {
            await this.google.search(token, list, '');
            this.warmed.set(key, Date.now());
        }
        return this.google.search(token, list, email);
    }

    /** Connected personal mailboxes that may read contacts, the owner's first; at most a handful. */
    private async mailboxes(
        workspaceId: string,
        ownerId: string | null,
    ): Promise<{ id: string; grantedScopes: string[] }[]> {
        const rows = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findMany({
                where: {
                    status: 'connected',
                    purpose: 'personal',
                    grantedScopes: { hasSome: [...GOOGLE_CONTACTS_SCOPES] },
                },
                select: { id: true, ownerMemberId: true, grantedScopes: true },
                orderBy: { createdAt: 'asc' },
            }),
        );
        rows.sort((a, b) => Number(b.ownerMemberId === ownerId) - Number(a.ownerMemberId === ownerId));
        return rows.slice(0, GOOGLE_CONTACTS_MAILBOXES);
    }
}

/** The lists a grant lets the source search: saved contacts first, then Gmail's other contacts. */
function listsFor(grantedScopes: readonly string[]): ContactList[] {
    const lists: ContactList[] = [];
    if (grantedScopes.includes(GOOGLE_CONTACTS_SCOPE)) lists.push('contacts');
    if (grantedScopes.includes(GOOGLE_OTHER_CONTACTS_SCOPE)) lists.push('other');
    return lists;
}

/**
 * The real picture of the contact with exactly this address, sized to `PICTURE_SIZE`; null when none. A
 * search matches on prefixes and names too, so the address is checked, and Google's generated letter
 * pictures (`default`) are never taken. Exported for the suite.
 */
export function pictureFor(matches: readonly GoogleContactMatch[], email: string): string | null {
    for (const m of matches) {
        if (!m.emails.some((e) => e.trim().toLowerCase() === email)) continue;
        const real = m.photos.filter((p) => !p.default);
        const photo = real.find((p) => p.primary) ?? real[0];
        if (photo)
            return /=s\d+(-c)?$/.test(photo.url) ? photo.url.replace(/=s\d+(-c)?$/, `=s${PICTURE_SIZE}`) : photo.url;
    }
    return null;
}
