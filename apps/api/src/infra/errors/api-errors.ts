import { HttpException } from '@nestjs/common';
import type { ErrorCode, FieldError } from '@bylinecrm/shared';

/**
 * An error whose code and field errors the throw site decides (P1-1d). The exception filter
 * renders it into the one envelope as it is. Plain Nest exceptions (`NotFoundException`, …) stay
 * fine for the common cases — the filter gives them the code their status maps to — and this
 * class is for the cases that carry more: field errors, or a code more specific than the status.
 */
export class ApiException extends HttpException {
    constructor(
        status: number,
        readonly code: ErrorCode,
        message: string,
        readonly fieldErrors?: readonly FieldError[],
    ) {
        super(message, status);
        this.name = new.target.name;
    }
}

/** `400`: the request did not validate. Paths are dotted paths into the request body. */
export class ValidationFailed extends ApiException {
    constructor(message: string, fieldErrors?: readonly FieldError[]) {
        super(400, 'validation.failed', message, fieldErrors);
    }
}

/**
 * `409`: a value that must be unique already exists. `field` names the body path when telling the
 * caller is safe; leave it out where naming the field would disclose who has an account.
 */
export class UniqueConflict extends ApiException {
    constructor(message: string, field?: string) {
        super(409, 'conflict.unique', message, field === undefined ? undefined : [{ path: field, message }]);
    }
}

/** `429`: too many attempts. */
export class RateLimited extends ApiException {
    constructor(message = 'too many attempts; try again later') {
        super(429, 'rate_limited', message);
    }
}
