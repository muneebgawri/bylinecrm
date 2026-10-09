import { describe, expect, it } from 'vitest';
import { ApiException, ValidationFailed } from './api-errors';
import { toParserException, UNPARSABLE_BODY_MESSAGE } from './body-parsing';
import { toErrorBody } from './error.filter';

const parserError = (status: number, type: string, message: string, expose = true) =>
    Object.assign(new Error(message), { status, expose, type });

describe('toParserException', () => {
    it('an unparsable JSON body becomes validation.failed with a plain message, not byte offsets', () => {
        const typed = toParserException(parserError(400, 'entity.parse.failed', 'Unexpected end of JSON input'));
        expect(typed).toBeInstanceOf(ValidationFailed);
        expect(toErrorBody(typed, 'req-0123456789')).toEqual({
            statusCode: 400,
            code: 'validation.failed',
            message: UNPARSABLE_BODY_MESSAGE,
            requestId: 'req-0123456789',
        });
    });

    it('a body over the limit becomes 413 payload_too_large', () => {
        const typed = toParserException(parserError(413, 'entity.too.large', 'request entity too large'));
        expect(typed).toBeInstanceOf(ApiException);
        expect(toErrorBody(typed, 'r-12345678')).toMatchObject({ statusCode: 413, code: 'payload_too_large' });
    });

    it('an unsupported charset becomes 415 unsupported_media_type', () => {
        const typed = toParserException(parserError(415, 'charset.unsupported', 'unsupported charset "UTF-7"'));
        expect(toErrorBody(typed, 'r-12345678')).toMatchObject({ statusCode: 415, code: 'unsupported_media_type' });
    });

    it('passes on anything that is not an exposed 4xx parser error', () => {
        const hidden = parserError(400, 'entity.parse.failed', 'secret', false);
        expect(toParserException(hidden)).toBe(hidden);
        const plain = new Error('boom');
        expect(toParserException(plain)).toBe(plain);
        expect(toParserException('x')).toBe('x');
    });
});
