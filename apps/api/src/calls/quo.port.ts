/** Injection token for Quo's API client; the suite overrides it with a fake. */
export const QUO_API = Symbol('QUO_API');

/** Why Quo did not answer: a key it refused (401/403), its rate limit (429), or it could not be reached. */
export class QuoApiError extends Error {
    constructor(
        readonly kind: 'unauthorized' | 'rate_limited' | 'not_found' | 'unavailable',
        message: string,
    ) {
        super(message);
        this.name = 'QuoApiError';
    }
}

export interface QuoUser {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
}

export interface QuoWebhook {
    id: string;
    /** The `whsec_…` signing key, given once at creation. */
    key: string;
}

/** A call as `GET /calls/{id}?include=summary,voicemail` answers it; only what the CRM keeps. */
export interface QuoCall {
    id: string;
    direction: 'incoming' | 'outgoing';
    status: string;
    phoneNumberId: string | null;
    /** The Quo user (or AI agent) on the call. */
    actorId: string | null;
    participants: { phoneNumber: string; actorId: string | null }[];
    createdAt: string;
    answeredAt: string | null;
    completedAt: string | null;
    /** Seconds. */
    duration: number | null;
    summary: { summary: string[] | null; nextSteps: string[] | null } | null;
    voicemail: { recordingUrl: string | null; duration: number | null } | null;
}

export interface QuoRecording {
    url: string;
    duration: number | null;
}

export interface QuoTranscript {
    dialogue: { userId: string | null; content: string; start: number; end: number }[];
}

/**
 * Quo's REST API, asked with the workspace's key (CALL-1). It reaches the network, so it is never called inside
 * a database transaction. 10 requests a second per key: a webhook burst is spread by the outbox, not here.
 */
export interface QuoApi {
    listUsers(apiKey: string): Promise<QuoUser[]>;
    createWebhook(
        apiKey: string,
        input: { url: string; events: readonly string[]; label: string },
    ): Promise<QuoWebhook>;
    deleteWebhook(apiKey: string, id: string): Promise<void>;
    getCall(apiKey: string, callId: string): Promise<QuoCall | null>;
    listRecordings(apiKey: string, callId: string): Promise<QuoRecording[]>;
    listTranscripts(apiKey: string, callId: string): Promise<QuoTranscript[]>;
}
