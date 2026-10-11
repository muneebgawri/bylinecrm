/**
 * The one error envelope (P1-1d). Every error the API sends — validation, a conflict, a missing
 * record, a refused gate, an unexpected failure — has this body. The web client reads only this
 * shape, and `apps/api/openapi.json` documents only this shape.
 */

/** Stable machine names for what went wrong. A client branches on `code`, never on `message`. */
export const ERROR_CODES = [
    /** The request body, query or path did not validate; `fieldErrors` says where when it can. */
    'validation.failed',
    /** No valid session or API key. */
    'unauthorized',
    /** Signed in, but this caller may not do this. */
    'forbidden',
    /** `403`: this deployment does not take sign-ups (`SIGNUP_MODE=closed`); join by a workspace invitation (P0-14). */
    'signup.closed',
    /** `403`: sign-up needs a valid platform sign-up invitation for this address (`SIGNUP_MODE=invite`). */
    'signup.invitation_required',
    /** `403`: the signed-in person has not verified their address yet; a mailed link does it (#93). */
    'email.unverified',
    /** `400`: a mailed single-use link is unknown, spent, expired or for something else (#93). */
    'token.invalid',
    /** `403`: the route is for platform admins (a verified address in `PLATFORM_ADMIN_EMAILS`). */
    'platform.forbidden',
    /** No such record, or not one this caller can see — the two are never told apart. */
    'not_found',
    /** The change conflicts with the record's current state (e.g. a stage that still has deals). */
    'conflict',
    /** The change would duplicate a value that must be unique; `fieldErrors` names the field when it is safe to. */
    'conflict.unique',
    /** The thing existed once and is no longer usable (an expired invitation). */
    'gone',
    /** The body is larger than the route accepts. */
    'payload_too_large',
    /** The body's media type is not one the route accepts. */
    'unsupported_media_type',
    /** The request is well-formed but refers to something it cannot use (a company the caller cannot see). */
    'unprocessable',
    /**
     * A recipient is on the workspace's suppression list (P3-1, FR-CRMS-7); `fieldErrors` names each
     * one at its field (`to`, `cc`, `bcc`) with the reason. Nothing was sent.
     */
    'recipient.suppressed',
    /** Too many attempts; try again later. */
    'rate_limited',
    /** Any other refusal of the request (a 4xx with no more specific code). */
    'bad_request',
    /** The route exists but is not built yet. */
    'not_implemented',
    /** Something failed on the server. The message is generic; `requestId` finds it in the logs. */
    'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The code a status gets when the code that raised it names none. One table, read by the API's filter. */
export const ERROR_CODE_FOR_STATUS: Readonly<Record<number, ErrorCode>> = {
    400: 'validation.failed',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    410: 'gone',
    413: 'payload_too_large',
    415: 'unsupported_media_type',
    422: 'unprocessable',
    429: 'rate_limited',
    501: 'not_implemented',
};

/**
 * The code for a status when nothing more specific was said: the table's entry, or the class's
 * catch-all — any other 4xx is `bad_request`, any 5xx `internal`. The API's filter and the web
 * client both use this, so a status means the same code on both sides.
 */
export function codeForStatus(status: number): ErrorCode {
    return ERROR_CODE_FOR_STATUS[status] ?? (status < 500 ? 'bad_request' : 'internal');
}

/** One problem with one field of the request, at its dotted path into the body: `emails.primary`, `custom.beat`. */
export interface FieldError {
    path: string;
    message: string;
}

/** Machine-readable facts about an error: flat, scalar values only. */
export type ErrorDetails = Record<string, string | number | boolean>;

/** Every error body the API sends. */
export interface ApiErrorBody {
    statusCode: number;
    code: ErrorCode;
    /** Human, safe to show. Never an internal detail. */
    message: string;
    fieldErrors?: FieldError[];
    /**
     * Facts a client can act on without parsing `message` — counts, limits — present only when the
     * code that raised the error has some (e.g. a stage delete refused for `{ liveDeals, trashedDeals }`).
     */
    details?: ErrorDetails;
    /** Echoed in the `X-Request-Id` header too; quote it when reporting a problem. */
    requestId: string;
}

/** The header a request id travels in, both ways. Lower-case: Node's header names are. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * An inbound request id is kept only when it looks like one: letters, digits, `.`, `_`, `-`,
 * 8–128 characters. Anything else is replaced, so a caller cannot write arbitrary text into logs.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
