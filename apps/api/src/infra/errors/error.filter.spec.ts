import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    GoneException,
    HttpException,
    InternalServerErrorException,
    NotFoundException,
    NotImplementedException,
    PayloadTooLargeException,
    UnauthorizedException,
    UnprocessableEntityException,
    UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ERROR_CODES, type ApiErrorBody } from '@bylinecrm/shared';
import { ZodValidationException } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RateLimited, StateConflict, TooLarge, UniqueConflict, ValidationFailed } from './api-errors';
import { INTERNAL_MESSAGE, INVALID_REQUEST_MESSAGE, toErrorBody } from './error.filter';

const RID = 'req-0123456789';

function body(exception: unknown): ApiErrorBody {
    return toErrorBody(exception, RID);
}

describe('toErrorBody — the one envelope, golden per kind', () => {
    it('a request DTO that failed validation: 400 validation.failed with dotted field paths', () => {
        const result = z
            .object({ emails: z.object({ primary: z.email() }), nameFirst: z.string() })
            .safeParse({ emails: { primary: 'nope' } });
        if (result.success) throw new Error('fixture must fail');
        expect(body(new ZodValidationException(result.error))).toEqual({
            statusCode: 400,
            code: 'validation.failed',
            message: INVALID_REQUEST_MESSAGE,
            fieldErrors: [
                { path: 'emails.primary', message: expect.any(String) as string },
                { path: 'nameFirst', message: expect.any(String) as string },
            ],
            requestId: RID,
        });
    });

    it('a typed validation failure keeps its message and field errors', () => {
        expect(
            body(new ValidationFailed('custom field values are invalid', [{ path: 'custom.beat', message: 'bad' }])),
        ).toEqual({
            statusCode: 400,
            code: 'validation.failed',
            message: 'custom field values are invalid',
            fieldErrors: [{ path: 'custom.beat', message: 'bad' }],
            requestId: RID,
        });
    });

    it('a state conflict carries its details so a client never parses the message (P1-2b)', () => {
        const body = toErrorBody(
            new StateConflict('3 deal(s) are in this stage', { liveDeals: 2, trashedDeals: 1 }),
            RID,
        );
        expect(body).toEqual({
            statusCode: 409,
            code: 'conflict',
            message: '3 deal(s) are in this stage',
            details: { liveDeals: 2, trashedDeals: 1 },
            requestId: RID,
        });
    });

    it('too much work for one request: 413 payload_too_large with the limit; no details key when there are none', () => {
        expect(toErrorBody(new TooLarge('too many', { deals: 6000, limit: 5000 }), RID)).toMatchObject({
            statusCode: 413,
            code: 'payload_too_large',
            details: { deals: 6000, limit: 5000 },
        });
        expect('details' in toErrorBody(new TooLarge('too many'), RID)).toBe(false);
    });

    it('a unique violation: 409 conflict.unique naming the field', () => {
        expect(body(new UniqueConflict('a person with that primary email exists', 'emails.primary'))).toEqual({
            statusCode: 409,
            code: 'conflict.unique',
            message: 'a person with that primary email exists',
            fieldErrors: [{ path: 'emails.primary', message: 'a person with that primary email exists' }],
            requestId: RID,
        });
    });

    it('a unique violation that must not name its field has no fieldErrors', () => {
        expect(body(new UniqueConflict('that sign-up cannot be completed'))).toEqual({
            statusCode: 409,
            code: 'conflict.unique',
            message: 'that sign-up cannot be completed',
            requestId: RID,
        });
    });

    it.each([
        [new NotFoundException('person not found'), 404, 'not_found', 'person not found'],
        [new ForbiddenException('not a member of this workspace'), 403, 'forbidden', 'not a member of this workspace'],
        [new ForbiddenException(), 403, 'forbidden', 'Forbidden'],
        [new UnauthorizedException(), 401, 'unauthorized', 'Unauthorized'],
        [new ConflictException('the stage still has deals'), 409, 'conflict', 'the stage still has deals'],
        [new GoneException('the invitation has expired'), 410, 'gone', 'the invitation has expired'],
        [new PayloadTooLargeException('the file is too large'), 413, 'payload_too_large', 'the file is too large'],
        [new UnsupportedMediaTypeException('not multipart'), 415, 'unsupported_media_type', 'not multipart'],
        [new UnprocessableEntityException('company not found'), 422, 'unprocessable', 'company not found'],
        [new BadRequestException('filter is too deep'), 400, 'validation.failed', 'filter is too deep'],
        [new RateLimited(), 429, 'rate_limited', 'too many attempts; try again later'],
        [
            new NotImplementedException('password reset arrives later'),
            501,
            'not_implemented',
            'password reset arrives later',
        ],
        [new HttpException('teapot', 418), 418, 'bad_request', 'teapot'],
    ])('%s → %i %s', (exception, statusCode, code, message) => {
        expect(body(exception)).toEqual({ statusCode, code, message, requestId: RID });
    });

    it('a Nest exception carrying a list of messages joins them', () => {
        const exception = new BadRequestException({ message: ['a is required', 'b is required'] });
        expect(body(exception).message).toBe('a is required; b is required');
    });
});

describe('toErrorBody — a server error sends nothing internal', () => {
    const secret = 'connect ECONNREFUSED 10.0.0.5:5432 password=hunter2';

    it('an unexpected Error is 500 internal with the generic message and no stack', () => {
        const error = new Error(secret);
        const result = body(error);
        expect(result).toEqual({ statusCode: 500, code: 'internal', message: INTERNAL_MESSAGE, requestId: RID });
        const wire = JSON.stringify(result);
        expect(wire).not.toContain('hunter2');
        expect(wire).not.toContain('10.0.0.5');
        expect(wire).not.toContain('at ');
    });

    it('a thrown non-Error is 500 internal too', () => {
        expect(body('just a string')).toEqual({
            statusCode: 500,
            code: 'internal',
            message: INTERNAL_MESSAGE,
            requestId: RID,
        });
    });

    it('a 5xx HttpException keeps its status but not its message', () => {
        expect(body(new InternalServerErrorException(secret))).toEqual({
            statusCode: 500,
            code: 'internal',
            message: INTERNAL_MESSAGE,
            requestId: RID,
        });
    });

    it('an Error that merely carries a status is still unexpected — only typed errors set a status', () => {
        const hidden = Object.assign(new Error(secret), { status: 400, expose: true });
        expect(body(hidden)).toMatchObject({ statusCode: 500, code: 'internal', message: INTERNAL_MESSAGE });
    });
});

describe('the code table', () => {
    it('every code the filter can produce is in ERROR_CODES', () => {
        const produced = new Set(
            [
                new NotFoundException(),
                new ForbiddenException(),
                new UnauthorizedException(),
                new ConflictException(),
                new GoneException(),
                new PayloadTooLargeException(),
                new UnsupportedMediaTypeException(),
                new UnprocessableEntityException(),
                new BadRequestException(),
                new NotImplementedException(),
                new HttpException('x', 418),
                new Error('x'),
                new RateLimited(),
                new UniqueConflict('x'),
            ].map((e) => body(e).code),
        );
        for (const code of produced) expect(ERROR_CODES).toContain(code);
    });
});
