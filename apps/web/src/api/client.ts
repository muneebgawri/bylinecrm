import { CSRF_COOKIE, CSRF_HEADER } from '@bylinecrm/shared';

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

export interface FieldError {
    /** Dotted path into the request body: `emails.primary`. */
    path: string;
    message: string;
}

/**
 * Every failed request, in one shape. `status` is the HTTP status, `code` is the API's short
 * error name when it sends one (`Unauthorized`, `Forbidden`, …) or the status text, and
 * `fieldErrors` carries validation failures by path so a form can place them.
 */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly fieldErrors: readonly FieldError[] = [],
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
    const response = await fetch(`${API_BASE}${path}`, init);

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
    signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string | undefined }> {
    const init: RequestInit = { method: 'GET', credentials: 'include' };
    if (signal) init.signal = signal;
    const response = await fetch(`${API_BASE}${path}`, init);
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

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

interface ErrorBody {
    statusCode?: number;
    error?: string;
    message?: string | string[];
    errors?: { path?: Array<string | number> | string; message?: string }[];
}

/** Nest's error envelope and nestjs-zod's validation envelope, folded into `ApiError`. */
function normaliseError(response: Response, payload: unknown): ApiError {
    const body: ErrorBody = typeof payload === 'object' && payload !== null ? (payload as ErrorBody) : {};
    const message = Array.isArray(body.message)
        ? body.message.join('; ')
        : (body.message ?? response.statusText ?? `HTTP ${response.status}`);
    const fieldErrors: FieldError[] = (body.errors ?? []).flatMap((issue) =>
        issue.message
            ? [{ path: Array.isArray(issue.path) ? issue.path.join('.') : (issue.path ?? ''), message: issue.message }]
            : [],
    );
    return new ApiError(response.status, body.error ?? response.statusText ?? 'Error', message, fieldErrors);
}
