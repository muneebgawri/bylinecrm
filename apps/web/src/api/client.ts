import {
    CSRF_COOKIE,
    CSRF_HEADER,
    codeForStatus,
    type ApiErrorBody,
    type ErrorCode,
    type ErrorDetails,
    type FieldError,
} from '@bylinecrm/shared';

export type { FieldError } from '@bylinecrm/shared';

/**
 * The one place the web app knows how to talk to the API: the base path, that the session
 * cookie rides along, that a state-changing request echoes the CSRF cookie in its header, and
 * what an error looks like. Every endpoint module calls `request`; nothing else calls `fetch`.
 *
 * The dev proxy and the production edge both serve the API under `/api`, so the path is relative
 * and there is no environment-specific origin to configure here.
 */
export const API_BASE = '/api';

/** The methods the API treats as state-changing; `CsrfGuard` on the server uses the same set. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Every failed request, in one shape — the API's one error envelope (`ApiErrorBody`). `code` is
 * the stable machine name to branch on, `fieldErrors` carry failures by body path so a form can
 * place them, `details` the flat facts a page acts on without parsing `message` (a refused stage
 * delete's `{ liveDeals, trashedDeals }`), and `requestId` is what a person quotes when reporting a
 * problem.
 */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: ErrorCode,
        message: string,
        readonly fieldErrors: readonly FieldError[] = [],
        readonly requestId: string | null = null,
        readonly details: Readonly<ErrorDetails> = {},
    ) {
        super(message);
        this.name = 'ApiError';
    }

    get isUnauthorized(): boolean {
        return this.status === 401;
    }

    get isForbidden(): boolean {
        return this.status === 403;
    }
}

/** True when the failure is the API saying so (not the network), so a retry would not help. */
export function isClientError(error: unknown): boolean {
    return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * A 401 anywhere means the session is gone. The router subscribes once and sends the person to
 * sign-in; endpoint code never handles 401 itself.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
    unauthorizedListeners.add(listener);
    return () => unauthorizedListeners.delete(listener);
}

/** Reads one cookie by name from a `document.cookie` string; `undefined` when absent. */
export function readCookie(name: string, source: string = document.cookie): string | undefined {
    for (const part of source.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return decodeURIComponent(rest.join('='));
    }
    return undefined;
}

export interface RequestOptions {
    /** JSON, or a `FormData` for a file upload (sent as multipart; the browser sets the boundary). */
    body?: unknown;
    signal?: AbortSignal | undefined;
}

/**
 * Sends one request and returns the parsed body (or `undefined` for 204). Throws `ApiError` for
 * any non-2xx response and lets network failures propagate as the `TypeError` fetch raises.
 */
export async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await send(method, path, options);

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const payload: unknown = text ? safeJson(text) : undefined;

    if (!response.ok) {
        const error = normaliseError(response, payload);
        if (error.isUnauthorized) for (const listener of unauthorizedListeners) listener();
        throw error;
    }
    return payload as T;
}

/**
 * Fetches a file the API streams (a CSV export) and returns it as a `Blob` with the name the API
 * gave it. A refusal arrives as the same `ApiError` a JSON route raises, so the caller can show
 * the API's reason (an export over the row cap is `413` with a message) instead of a broken file.
 */
export async function requestFile(
    path: string,
    options: RequestOptions & { method?: 'GET' | 'POST' } = {},
): Promise<{ blob: Blob; filename: string | undefined }> {
    const { method = 'GET', ...rest } = options;
    const response = await send(method, path, rest);
    if (!response.ok) {
        const text = await response.text();
        const error = normaliseError(response, text ? safeJson(text) : undefined);
        if (error.isUnauthorized) for (const listener of unauthorizedListeners) listener();
        throw error;
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1];
    return { blob: await response.blob(), filename };
}

/**
 * The one place a request leaves the app: base URL, credentials, the CSRF header on a mutating
 * method, JSON or multipart body. `request` and `requestFile` differ only in how they read the answer.
 */
function send(method: Method, path: string, options: RequestOptions): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json' });
    const multipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
    if (options.body !== undefined && !multipart) headers.set('Content-Type', 'application/json');
    if (MUTATING.has(method)) {
        const csrf = readCookie(CSRF_COOKIE);
        if (csrf) headers.set(CSRF_HEADER, csrf);
    }

    const init: RequestInit = { method, headers, credentials: 'include' };
    if (multipart) init.body = options.body as FormData;
    else if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (options.signal) init.signal = options.signal;
    return fetch(`${API_BASE}${path}`, init);
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * The API's error envelope into `ApiError`. A body that is not the envelope (an edge proxy's
 * 502 page, an empty body) still becomes an `ApiError`, coded from its status the same way the
 * API codes one.
 */
function normaliseError(response: Response, payload: unknown): ApiError {
    if (isEnvelope(payload)) {
        return new ApiError(
            response.status,
            payload.code,
            payload.message,
            payload.fieldErrors ?? [],
            payload.requestId,
            payload.details ?? {},
        );
    }
    return new ApiError(
        response.status,
        codeForStatus(response.status),
        response.statusText || `HTTP ${response.status}`,
    );
}

function isEnvelope(payload: unknown): payload is ApiErrorBody {
    if (typeof payload !== 'object' || payload === null) return false;
    const body = payload as Partial<ApiErrorBody>;
    return typeof body.code === 'string' && typeof body.message === 'string' && typeof body.requestId === 'string';
}

/**
 * The API's message for one request-body path (`postalAddress.city`), when it named that field;
 * `undefined` otherwise. A form places each message under its own field with this.
 */
export function fieldErrorAt(error: unknown, path: string): string | undefined {
    return error instanceof ApiError ? error.fieldErrors.find((f) => f.path === path)?.message : undefined;
}

/** One numeric fact from an error's `details` (a count, a limit); `undefined` when absent or not a number. */
export function detailNumber(error: unknown, key: string): number | undefined {
    if (!(error instanceof ApiError)) return undefined;
    const value = error.details[key];
    return typeof value === 'number' ? value : undefined;
}
