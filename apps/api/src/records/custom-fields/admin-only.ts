import {
    applyDecorators,
    type CallHandler,
    type ExecutionContext,
    Injectable,
    type NestInterceptor,
    SetMetadata,
    UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RecordObject } from '@bylinecrm/shared';
import { from, mergeMap, type Observable } from 'rxjs';
import { CustomFieldsService } from './custom-fields.service';

const RECORD_OBJECT = 'custom-fields:record-object';

/**
 * Marks a controller (or route) whose responses carry records of `object`: for a caller without
 * `workspace:admin`, every `custom` object in the response loses its admin-only keys. One place
 * for every shape a route returns — a record, a page, a board's columns, a stage move's deal.
 */
export function HidesAdminOnlyFields(object: RecordObject): ClassDecorator & MethodDecorator {
    return applyDecorators(SetMetadata(RECORD_OBJECT, object), UseInterceptors(AdminOnlyFieldsInterceptor));
}

@Injectable()
export class AdminOnlyFieldsInterceptor implements NestInterceptor {
    constructor(
        private readonly reflector: Reflector,
        private readonly customFields: CustomFieldsService,
    ) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const object = this.reflector.getAllAndOverride<RecordObject | undefined>(RECORD_OBJECT, [
            context.getHandler(),
            context.getClass(),
        ]);
        return next.handle().pipe(
            mergeMap((body: unknown) =>
                from(
                    (async () => {
                        if (!object || body === undefined || !this.customFields.restricted()) return body;
                        const hidden = await this.customFields.hiddenKeys(object);
                        return hidden.size > 0 ? withoutHidden(body, hidden) : body;
                    })(),
                ),
            ),
        );
    }
}

/** `value` with `hidden` taken out of every `custom` object at any depth; other values as they were. */
export function withoutHidden<T>(value: T, hidden: ReadonlySet<string>): T {
    if (Array.isArray(value)) return value.map((v: unknown) => withoutHidden(v, hidden)) as T;
    if (!isPlain(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
        out[key] = key === 'custom' && isPlain(v) ? stripKeys(v, hidden) : withoutHidden(v, hidden);
    }
    return out as T;
}

/** A `custom` object without the hidden keys. */
export function stripKeys(custom: Record<string, unknown>, hidden: ReadonlySet<string>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(custom).filter(([k]) => !hidden.has(k)));
}

function isPlain(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value) as unknown;
    return proto === Object.prototype || proto === null;
}
