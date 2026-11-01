import { Injectable } from '@nestjs/common';
import { errorReason } from '../calendar/google-calendar.http';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import { GOOGLE_PEOPLE_API_BASE, GOOGLE_PEOPLE_HTTP_TIMEOUT_MS } from './enrichment.constants';
import {
    GoogleContactsError,
    type ContactList,
    type GoogleContactMatch,
    type GoogleContactsPort,
} from './google-contacts.port';

const PATHS: Readonly<Record<ContactList, string>> = {
    contacts: '/people:searchContacts',
    other: '/otherContacts:search',
};

/**
 * Google's People API (AVATAR-1): the only code in the product that reads a member's contacts. The bearer
 * token comes from `MailboxTokens`; nothing here stores it, and no error message carries it.
 */
@Injectable()
export class GoogleContactsHttp implements GoogleContactsPort {
    async search(accessToken: string, list: ContactList, query: string): Promise<GoogleContactMatch[]> {
        assertNoOpenTransaction('GoogleContactsHttp.search');
        const params = new URLSearchParams({ query, readMask: 'emailAddresses,photos', pageSize: '10' });
        let response: Response;
        try {
            response = await fetch(`${GOOGLE_PEOPLE_API_BASE}${PATHS[list]}?${params.toString()}`, {
                headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
                signal: AbortSignal.timeout(GOOGLE_PEOPLE_HTTP_TIMEOUT_MS),
            });
        } catch (error) {
            const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
            throw new GoogleContactsError(null, reason, `Google People API did not answer (${reason})`);
        }
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok) {
            const reason = errorReason(body) ?? `http_${response.status}`;
            throw new GoogleContactsError(
                response.status,
                reason,
                `Google People API answered ${response.status} (${reason})`,
            );
        }
        const results = (body as { results?: unknown } | null)?.results;
        return Array.isArray(results) ? results.map((r) => match((r as { person?: unknown }).person)) : [];
    }
}

/** A result's person, read defensively: anything missing is an empty list. */
function match(person: unknown): GoogleContactMatch {
    const p = (person ?? {}) as {
        emailAddresses?: { value?: unknown }[];
        photos?: { url?: unknown; default?: unknown; metadata?: { primary?: unknown } }[];
    };
    return {
        emails: (p.emailAddresses ?? []).flatMap((e) => (typeof e.value === 'string' ? [e.value] : [])),
        photos: (p.photos ?? []).flatMap((ph) =>
            typeof ph.url === 'string'
                ? [{ url: ph.url, default: ph.default === true, primary: ph.metadata?.primary === true }]
                : [],
        ),
    };
}
