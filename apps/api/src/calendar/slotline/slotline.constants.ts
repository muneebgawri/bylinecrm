/**
 * Every number and fixed string the Slotline hook (CAL-2) runs on, in one place.
 */

/** Where Slotline posts bookings: `APP_URL` + this + `/<token>`. */
export const SLOTLINE_HOOK_PATH = '/api/hooks/slotline';

/** The header Slotline (as Cal.com) signs a delivery in: hex HMAC-SHA256 of the raw body with the webhook's secret. */
export const SLOTLINE_SIGNATURE_HEADER = 'x-cal-signature-256';

/**
 * The booking events the CRM reads. A webhook in Slotline subscribed to these (and no others is needed);
 * any other trigger is acknowledged and ignored.
 */
export const SLOTLINE_BOOKING_TRIGGERS = ['BOOKING_CREATED', 'BOOKING_REQUESTED', 'BOOKING_RESCHEDULED'] as const;
export const SLOTLINE_CANCEL_TRIGGERS = ['BOOKING_CANCELLED', 'BOOKING_REJECTED'] as const;
/** What Slotline sends when someone presses "Ping test" on the webhook. */
export const SLOTLINE_PING_TRIGGER = 'PING';

/** What a person created from a booking's attendee has as `source`. */
export const SLOTLINE_LEAD_SOURCE = 'Slotline';

/** A secret shorter than this is refused: it is all that stands between the public hook and forged bookings. */
export const SLOTLINE_SECRET_MIN = 16;
export const SLOTLINE_SECRET_MAX = 200;
export const SLOTLINE_BASE_URL_MAX = 200;

/**
 * The public hook's brake, per client IP — on refused deliveries only (no such hook, a wrong signature): a
 * guesser is stopped, while Slotline's real bookings, all from one server that never retries, are never throttled.
 */
export const SLOTLINE_HOOK_FAILURE_LIMIT = 30;
export const SLOTLINE_HOOK_FAILURE_WINDOW_S = 600;
export const slotlineHookRateKey = (ip: string) => `slotline-hook:${ip}`;
