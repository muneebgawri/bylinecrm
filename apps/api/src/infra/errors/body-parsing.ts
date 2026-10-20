import { codeForStatus } from '@bylinecrm/shared';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { ApiException, ValidationFailed } from './api-errors';

/** What a request body that is not JSON is told. The parser's own message names byte offsets. */
export const UNPARSABLE_BODY_MESSAGE = 'the request body is not valid JSON';

/**
 * The request body parsers, installed by `createApp` instead of Nest's built-in ones (P1-1d).
 * Same parsers and options Nest would use — JSON, and URL-encoded with `extended` — but owning
 * them lets `parserErrors` sit directly behind them: Nest would otherwise turn a parser's
 * `SyntaxError` into a bare 400 carrying the parser's text, with nothing left to tell it apart.
 */
export function bodyParsers(): RequestHandler[] {
    const hookJson = express.json({ verify: keepRawBody, limit: HOOK_BODY_LIMIT });
    // The hook parser runs first on its paths; the general one then sees the body already read and passes.
    const hooks: RequestHandler = (req, res, next) => (keepsRawBody(req.url) ? hookJson(req, res, next) : next());
    return [hooks, express.json(), express.urlencoded({ extended: true })];
}

/**
 * Inbound hooks (CAL-2's Slotline hook) are signed over the exact bytes sent, which the parsed body cannot
 * give back: under `RAW_BODY_PATH_PREFIX` the parser keeps them on the request as `rawBody`. Nowhere else, so
 * no other request carries its body twice. A sender that never retries loses what is refused, so a booking with
 * long answers to its questions gets more room than the default 100 kB.
 */
export const RAW_BODY_PATH_PREFIX = '/api/hooks/';
/** A tenant's signed inbound receiver (BYL-1: `/api/w/:id/inbound/byline`), signed over its bytes as the hooks are. */
const INBOUND_PATH = /^\/api\/w\/[^/]+\/inbound\//;

/** Whether a request's raw body is kept for its signature check. Exported for the suite. */
export function keepsRawBody(url: string): boolean {
    return url.startsWith(RAW_BODY_PATH_PREFIX) || INBOUND_PATH.test(url);
}
const HOOK_BODY_LIMIT = '1mb';

export interface RequestWithRawBody {
    rawBody?: Buffer;
}

function keepRawBody(req: object, _res: unknown, buffer: Buffer): void {
    (req as RequestWithRawBody).rawBody = buffer;
}

/** Turns a parser rejection into the typed error the exception filter renders; passes anything else on. */
export const parserErrors: ErrorRequestHandler = (err: unknown, _req, _res, next) => {
    next(toParserException(err));
};

/**
 * Express's body parser rejects a request with an `http-errors` error: a 4xx `status`,
 * `expose: true` (its message is meant for a client) and a `type`. Anything else is not ours.
 */
export function toParserException(err: unknown): unknown {
    if (!(err instanceof Error)) return err;
    const candidate = err as Error & { status?: unknown; expose?: unknown; type?: unknown };
    if (typeof candidate.status !== 'number' || candidate.expose !== true) return err;
    if (candidate.status < 400 || candidate.status >= 500) return err;
    if (candidate.type === 'entity.parse.failed') return new ValidationFailed(UNPARSABLE_BODY_MESSAGE);
    return new ApiException(candidate.status, codeForStatus(candidate.status), candidate.message);
}
