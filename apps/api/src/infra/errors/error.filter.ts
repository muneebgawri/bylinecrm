import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { codeForStatus, type ApiErrorBody, type ErrorCode, type FieldError } from '@bylinecrm/shared';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { ApiException } from './api-errors';
import { requestIdOf } from './request-id';

/** What a client sees for any failure on our side. The detail is in the log, under the request id. */
export const INTERNAL_MESSAGE = 'something went wrong on our side; quote the request id if you report it';

/** What a request that failed DTO validation is told; `fieldErrors` say where. */
export const INVALID_REQUEST_MESSAGE = 'the request is not valid';

/**
 * The one place an error becomes a response (P1-1d). Every exception — a typed `ApiException`, a
 * Nest `HttpException` (a body the parser refused arrives as one — see `body-parsing.ts`), a
 * request DTO that failed validation, or anything unexpected — leaves as `ApiErrorBody`, with the request id in the body and the header.
 * An unexpected error is logged with its stack and answered with a generic message; nothing
 * internal is ever sent.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
    private readonly logger = new Logger('Errors');

    catch(exception: unknown, host: ArgumentsHost): void {
        const http = host.switchToHttp();
        const req = http.getRequest<Request>();
        const res = http.getResponse<Response>();
        const requestId = requestIdOf(req, res);
        const body = toErrorBody(exception, requestId);
        if (body.statusCode >= 500 && body.code !== 'not_implemented') {
            const stack = exception instanceof Error ? exception.stack : String(exception);
            this.logger.error(`${requestId} ${req.method} ${req.originalUrl}: ${describe(exception)}`, stack);
        }
        if (res.headersSent) {
            // A streamed response (an export) failed after its first byte: the status is sent and
            // the body is partial. Closing it is all that is left; the log has the cause.
            res.destroy();
            return;
        }
        res.status(body.statusCode).json(body);
    }
}

/** The envelope for `exception`. Pure, so every mapping rule is unit-tested without a server. */
export function toErrorBody(exception: unknown, requestId: string): ApiErrorBody {
    if (exception instanceof ApiException) {
        return envelope(exception.getStatus(), exception.code, exception.message, requestId, exception.fieldErrors);
    }
    if (exception instanceof ZodValidationException) {
        return envelope(400, 'validation.failed', INVALID_REQUEST_MESSAGE, requestId, zodFieldErrors(exception));
    }
    if (exception instanceof HttpException) {
        const status = exception.getStatus();
        return envelope(status, codeForStatus(status), messageOf(exception, status), requestId);
    }
    return envelope(500, 'internal', INTERNAL_MESSAGE, requestId);
}

function envelope(
    statusCode: number,
    code: ErrorCode,
    message: string,
    requestId: string,
    fieldErrors?: readonly FieldError[],
): ApiErrorBody {
    return {
        statusCode,
        code,
        message,
        ...(fieldErrors && fieldErrors.length > 0 ? { fieldErrors: [...fieldErrors] } : {}),
        requestId,
    };
}

/** The message a Nest exception was raised with; a server error's is replaced by the generic one. */
function messageOf(exception: HttpException, status: number): string {
    if (status >= 500 && status !== 501) return INTERNAL_MESSAGE;
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
    return exception.message;
}

function zodFieldErrors(exception: ZodValidationException): FieldError[] {
    const error = exception.getZodError() as { issues?: { path: PropertyKey[]; message: string }[] };
    return (error.issues ?? []).map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
    }));
}

function describe(exception: unknown): string {
    return exception instanceof Error ? `${exception.name}: ${exception.message}` : 'non-Error thrown';
}
