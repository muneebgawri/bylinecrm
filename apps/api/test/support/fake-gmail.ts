import {
    GmailApiError,
    type GmailHistoryPage,
    type GmailMessagePage,
    type GmailPart,
    type GmailPort,
    type GmailProfile,
    type GmailRawMessage,
} from '../../src/mail-sync/gmail.port';
import type { FakeGoogleOAuth } from './fake-google-oauth';

/** A message to put in a fixture mailbox. Defaults make a plain inbound message from `from`. */
export interface FixtureMessage {
    from: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    /** When it was sent; defaults to now. */
    date?: Date;
    labels?: string[];
    /** A thread to add the message to; a new thread otherwise. */
    threadId?: string;
    messageIdHeader?: string;
    inReplyTo?: string;
    attachment?: boolean;
}

interface FakeMailbox {
    messages: Map<string, GmailRawMessage>;
    /** Message ids, newest last. */
    order: string[];
    /** Each history step: the id after which the message was added. */
    history: { historyId: number; messageId: string }[];
    historyId: number;
    /** History before this id is gone: a start id below it answers 404. */
    oldestHistoryId: number;
    nextMessage: number;
    nextThread: number;
}

type Method = 'getProfile' | 'listMessages' | 'listHistory' | 'getMessage';

/**
 * An in-memory Gmail for the tests: no network, ever. Access tokens are the fake OAuth's — a token
 * resolves to the mailbox its grant is for, and a revoked grant is refused — so sync passes only
 * if it uses the token `MailboxTokens` hands out. Messages are built as Gmail returns them
 * (`format=full`, base64url parts), so the real parser reads them.
 */
export class FakeGmail implements GmailPort {
    private readonly mailboxes = new Map<string, FakeMailbox>();
    private readonly failures: { email: string; method: Method; status: number; remaining: number }[] = [];
    /** Every call made, for assertions: method, mailbox, and the message id for getMessage. */
    readonly calls: { method: Method; email: string; id?: string }[] = [];
    /** Page sizes small enough that the tests exercise paging. */
    listPageSize = 3;
    historyPageSize = 2;

    constructor(private readonly oauth: FakeGoogleOAuth) {}

    // ── Fixture control ─────────────────────────────────────────────────────────────────────

    /** Adds a message to the mailbox; returns Gmail's ids for it. */
    deliver(email: string, fixture: FixtureMessage): { id: string; threadId: string } {
        const box = this.box(email);
        const id = `msg-${email}-${box.nextMessage++}`;
        const threadId = fixture.threadId ?? `thr-${email}-${box.nextThread++}`;
        const date = fixture.date ?? new Date();
        const headers = [
            { name: 'From', value: fixture.from },
            ...(fixture.to?.length ? [{ name: 'To', value: fixture.to.join(', ') }] : []),
            ...(fixture.cc?.length ? [{ name: 'Cc', value: fixture.cc.join(', ') }] : []),
            { name: 'Subject', value: fixture.subject ?? '(no subject)' },
            { name: 'Date', value: date.toUTCString() },
            { name: 'Message-ID', value: `<${fixture.messageIdHeader ?? `${id}@fake.example`}>` },
            ...(fixture.inReplyTo ? [{ name: 'In-Reply-To', value: `<${fixture.inReplyTo}>` }] : []),
        ];
        const parts: GmailPart[] = [];
        if (fixture.text !== undefined) parts.push({ mimeType: 'text/plain', body: { data: b64(fixture.text) } });
        if (fixture.html !== undefined) parts.push({ mimeType: 'text/html', body: { data: b64(fixture.html) } });
        if (fixture.attachment)
            parts.push({ mimeType: 'application/pdf', filename: 'deck.pdf', body: { attachmentId: 'a1', size: 10 } });
        const payload: GmailPart =
            parts.length === 1 && !fixture.attachment
                ? { ...parts[0]!, headers }
                : {
                      mimeType: 'multipart/mixed',
                      headers,
                      parts: parts.length ? parts : [{ mimeType: 'text/plain', body: { data: b64('') } }],
                  };
        box.messages.set(id, {
            id,
            threadId,
            labelIds: fixture.labels ?? ['INBOX'],
            // Gmail's snippet is a short preview of the body, never all of it.
            snippet: (fixture.text ?? fixture.html ?? '').slice(0, SNIPPET_CHARS),
            internalDate: String(date.getTime()),
            payload,
        });
        box.order.push(id);
        box.historyId += 1;
        box.history.push({ historyId: box.historyId, messageId: id });
        return { id, threadId };
    }

    /** Gmail reports an already-delivered message again in its history (it does, for label changes). */
    repeatInHistory(email: string, messageId: string): void {
        const box = this.box(email);
        box.historyId += 1;
        box.history.push({ historyId: box.historyId, messageId });
    }

    /** Gmail forgets all history so far: a start id from before now answers 404. */
    expireHistory(email: string): void {
        const box = this.box(email);
        box.historyId += 1;
        box.oldestHistoryId = box.historyId;
    }

    /** The next `times` calls of `method` for the mailbox fail with `status`. */
    failNext(email: string, method: Method, status: number, times = 1): void {
        this.failures.push({ email, method, status, remaining: times });
    }

    /** Drops every queued failure. */
    clearFailures(): void {
        this.failures.length = 0;
    }

    callsOf(method: Method, email: string): number {
        return this.calls.filter((c) => c.method === method && c.email === email).length;
    }

    // ── GmailPort ───────────────────────────────────────────────────────────────────────────

    async getProfile(accessToken: string): Promise<GmailProfile> {
        const email = await this.enter('getProfile', accessToken);
        return { emailAddress: email, historyId: String(this.box(email).historyId) };
    }

    async listMessages(accessToken: string, input: { query: string; pageToken?: string }): Promise<GmailMessagePage> {
        const email = await this.enter('listMessages', accessToken);
        const box = this.box(email);
        const after = /after:(\d+)/.exec(input.query);
        const since = after ? Number(after[1]) * 1000 : 0;
        const matching = [...box.order]
            .reverse()
            .map((id) => box.messages.get(id)!)
            .filter(
                (m) =>
                    Number(m.internalDate) >= since && !(m.labelIds ?? []).some((l) => l === 'SPAM' || l === 'TRASH'),
            );
        const start = input.pageToken ? Number(input.pageToken) : 0;
        const slice = matching.slice(start, start + this.listPageSize);
        const next = start + this.listPageSize < matching.length ? String(start + this.listPageSize) : null;
        return { messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: next };
    }

    async listHistory(
        accessToken: string,
        input: { startHistoryId: string; pageToken?: string },
    ): Promise<GmailHistoryPage> {
        const email = await this.enter('listHistory', accessToken);
        const box = this.box(email);
        const startId = Number(input.startHistoryId);
        if (startId < box.oldestHistoryId) throw new GmailApiError(404, 'notFound', 'Gmail answered 404 (notFound)');
        const steps = box.history.filter((h) => h.historyId > startId);
        const start = input.pageToken ? Number(input.pageToken) : 0;
        const slice = steps.slice(start, start + this.historyPageSize);
        const next = start + this.historyPageSize < steps.length ? String(start + this.historyPageSize) : null;
        return {
            addedMessageIds: slice.map((h) => h.messageId),
            historyId: String(box.historyId),
            nextPageToken: next,
        };
    }

    async getMessage(accessToken: string, id: string): Promise<GmailRawMessage> {
        const email = await this.enter('getMessage', accessToken, id);
        const message = this.box(email).messages.get(id);
        if (!message) throw new GmailApiError(404, 'notFound', 'Gmail answered 404 (notFound)');
        return structuredClone(message);
    }

    // ── Internals ───────────────────────────────────────────────────────────────────────────

    /** Resolves the token to its mailbox (as Google would), records the call, applies a queued failure. */
    private async enter(method: Method, accessToken: string, id?: string): Promise<string> {
        let email: string;
        try {
            email = await this.oauth.mailboxAddress(accessToken);
        } catch {
            throw new GmailApiError(401, 'authError', 'Gmail answered 401 (authError)');
        }
        this.calls.push({ method, email, ...(id ? { id } : {}) });
        const failure = this.failures.find((f) => f.email === email && f.method === method && f.remaining > 0);
        if (failure) {
            failure.remaining -= 1;
            throw new GmailApiError(
                failure.status,
                failure.status === 429 ? 'rateLimitExceeded' : 'backendError',
                `Gmail answered ${failure.status}`,
            );
        }
        return email;
    }

    private box(email: string): FakeMailbox {
        let box = this.mailboxes.get(email);
        if (!box) {
            box = {
                messages: new Map(),
                order: [],
                history: [],
                historyId: 100,
                oldestHistoryId: 0,
                nextMessage: 1,
                nextThread: 1,
            };
            this.mailboxes.set(email, box);
        }
        return box;
    }
}

/** How much of the body the fake's snippet previews. */
const SNIPPET_CHARS = 20;

function b64(value: string): string {
    return Buffer.from(value).toString('base64url');
}
