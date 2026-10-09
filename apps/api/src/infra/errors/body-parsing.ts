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
    return [express.json(), express.urlencoded({ extended: true })];
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
