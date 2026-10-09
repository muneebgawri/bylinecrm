import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER, REQUEST_ID_PATTERN } from '@bylinecrm/shared';
import type { NextFunction, Request, Response } from 'express';

/** The request id a request carries once `requestId` has run; read it with `requestIdOf`. */
const REQUEST_ID = Symbol('requestId');

type WithRequestId = Request & { [REQUEST_ID]?: string };

/** An inbound id when it is well-formed, a fresh one otherwise. */
export function chooseRequestId(inbound: unknown): string {
    return typeof inbound === 'string' && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
}

/**
 * Express middleware, installed first so even a request the body parser rejects has an id: it
 * picks the id, stores it on the request and sets the response header before anything can fail.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
    const id = chooseRequestId(req.headers[REQUEST_ID_HEADER]);
    (req as WithRequestId)[REQUEST_ID] = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
}

/**
 * The id of `req`. A request that never passed the middleware (an application built without
 * `createApp`) gets one here, once, and the response header is set with it.
 */
export function requestIdOf(req: Request, res?: Response): string {
    const holder = req as WithRequestId;
    if (!holder[REQUEST_ID]) {
        holder[REQUEST_ID] = chooseRequestId(req.headers?.[REQUEST_ID_HEADER]);
        if (res && !res.headersSent) res.setHeader(REQUEST_ID_HEADER, holder[REQUEST_ID]);
    }
    return holder[REQUEST_ID];
}
