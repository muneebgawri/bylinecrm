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

/** One page of Slotline's admin route `GET /api/admin/bookings/changes`. */
export interface SlotlineBookingChanges {
    /** Each booking's fields, named as in a webhook delivery's `payload` (read by `slotlineDeliveryFor`). */
    bookings: Record<string, unknown>[];
    nextCursor: string | null;
    /** The window's end on Slotline's clock: the next page is asked with it, and a finished pass keeps it. */
    until: string;
}

/**
 * Slotline's admin route, server to server with the instance's admin key (`SLOTLINE_ADMIN_API_KEY`, not a
 * member's): every user's bookings created or changed after `since`, up to `until` (Slotline's now when left
 * out), a page at a time. The same HTTP adapter; its own port, as only the catch-up uses it.
 */
export interface SlotlineAdminApiPort {
    bookingChanges(
        baseUrl: string,
        adminKey: string,
        page: { since: Date; until?: string | undefined; cursor?: string | undefined },
    ): Promise<SlotlineBookingChanges>;
}

export const SLOTLINE_ADMIN_API_PORT = Symbol('SLOTLINE_ADMIN_API_PORT');

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
