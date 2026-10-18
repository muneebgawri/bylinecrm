/**
 * Slotline's v2 API (#196), reached through the booking site's own `/api/v2` proxy with a member's
 * personal API key: who the key belongs to, and every event type on that account — hidden ones too, which
 * Slotline returns only to the owner. One port; the HTTP adapter and the tests' fake implement it.
 */

/** An event type as the signature picker needs it. */
export interface SlotlineEventType {
    slug: string;
    title: string;
    lengthInMinutes: number | null;
    /** Not on the member's public page, but bookable by its link. */
    hidden: boolean;
}

export interface SlotlineApiPort {
    /** The key's owner (`GET /api/v2/me`). */
    me(baseUrl: string, apiKey: string): Promise<{ username: string }>;
    /** Every event type of the key's owner (`GET /api/v2/event-types`, version 2024-06-14). */
    eventTypes(baseUrl: string, apiKey: string): Promise<SlotlineEventType[]>;
}

export const SLOTLINE_API_PORT = Symbol('SLOTLINE_API_PORT');

/** Slotline refused or did not answer. `status` is null when there was no answer. The key is never in the message. */
export class SlotlineApiError extends Error {
    constructor(
        readonly status: number | null,
        message: string,
    ) {
        super(message);
        this.name = 'SlotlineApiError';
    }

    /** The key itself was refused: wrong, revoked, or without the permission. */
    get refused(): boolean {
        return this.status === 401 || this.status === 403;
    }
}
