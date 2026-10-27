import { applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import {
    ACTOR_KINDS,
    ERROR_CODES,
    RECORD_OBJECTS,
    type Actor,
    type Address,
    type ApiErrorBody,
    type Emails,
    type Links,
    type Money,
    type Phones,
    type RecordTarget,
    type RichText,
    type RichTextNode,
} from '@bylinecrm/shared';
import { z } from 'zod';

/**
 * The response half of the contract (P1-1c). Every response body the API sends is a zod schema
 * registered here under the name it takes in `components.schemas`; the TypeScript type a service
 * returns is `z.output` of that schema, so the type and the document are one definition. The
 * document builder (`document.ts`) turns the registry into components with
 * `z.toJSONSchema(…, { target: 'openapi-3.0', io: 'input' })` — `input` because the wire carries
 * what a client would send back: an ISO string where the service holds a `Date`.
 */
export const responseSchemas = z.registry<{ id: string }>();

/** Registers `schema` as the component `id`; returns it so it can be used in the same expression. */
export function named<S extends z.ZodType>(id: string, schema: S): S {
    responseSchemas.add(schema, { id });
    return schema;
}

/** The component name of a registered schema; a schema used in a response must be registered. */
export function componentName(schema: z.ZodType): string {
    const meta = responseSchemas.get(schema);
    if (!meta) throw new Error('a response schema must be registered with named() before a route uses it');
    return meta.id;
}

/** Examples for the formats a mock cannot invent sensibly; Prism serves them (`pnpm mock:api`). */
export const EXAMPLE_ID = '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';
export const EXAMPLE_TIME = '2026-10-09T09:30:00.000Z';

export const id = z.uuid().meta({ example: EXAMPLE_ID });

/**
 * A moment: a `Date` in the service, an ISO 8601 string on the wire. JSON serialisation does the
 * encoding at run time; this codec says so to the type system and to the document.
 */
export const dateTime = z
    .codec(z.iso.datetime(), z.date(), {
        decode: (value) => new Date(value),
        encode: (value) => value.toISOString(),
    })
    .meta({ example: EXAMPLE_TIME });

/** One page of a list: exactly what `paginate` returns. */
export function page<S extends z.ZodType>(
    item: S,
): z.ZodObject<{ items: z.ZodArray<S>; nextCursor: z.ZodNullable<z.ZodString> }> {
    return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/**
 * A record list's page with its total (P1-4a): counted over the same filtered, scoped set,
 * up to `LIST_COUNT_CAP`; past it `totalIsExact` is false and `total` is the cap.
 */
export function countedPage<S extends z.ZodType>(item: S) {
    return page(item).extend({
        total: z
            .number()
            .int()
            .meta({ description: 'Rows in the whole filtered, scoped set (capped; see totalIsExact).' }),
        totalIsExact: z.boolean(),
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared composites. Their TypeScript types live in @bylinecrm/shared (the web app imports
// them and must not import zod — P1-4's bundle finding), so each schema here is held to its type
// by a compile-time check below: if either side changes alone, `typecheck` fails.
// ─────────────────────────────────────────────────────────────────────────────

export const actor = named('Actor', z.object({ kind: z.enum(ACTOR_KINDS), id: id.nullable() }));

export const emails = named('Emails', z.object({ primary: z.string().nullable(), additional: z.array(z.string()) }));

const phone = z.object({
    number: z.string(),
    countryCode: z.string(),
    extension: z.string().optional().meta({ description: 'Digits dialled once connected; absent when there is none.' }),
});
export const phones = named('Phones', z.object({ primary: phone.nullable(), additional: z.array(phone) }));

const link = z.object({ url: z.string(), label: z.string().nullable() });
export const links = named('Links', z.object({ linkedin: link.nullable(), x: link.nullable() }));

export const address = named(
    'Address',
    z.object({
        street: z.string().nullable(),
        city: z.string().nullable(),
        state: z.string().nullable(),
        country: z.string().nullable(),
        postalCode: z.string().nullable(),
    }),
);

export const money = named(
    'Money',
    z.object({ amountMinor: z.number().int(), currency: z.string().meta({ example: 'USD' }) }),
);

export const recordTarget = named('RecordTarget', z.object({ type: z.enum(RECORD_OBJECTS), id }));

const richTextNode: z.ZodType<RichTextNode> = named(
    'RichTextNode',
    z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        content: z.array(z.lazy(() => richTextNode)).optional(),
    }),
);
export const richText = named(
    'RichText',
    z.object({ type: z.literal('doc'), content: z.array(richTextNode).optional() }),
);

/** The custom-field values of a record, keyed by field key. */
export const customValues = z.record(z.string(), z.unknown());

/** `true` when each type is assignable to the other — the same shape, whichever way it is spelled. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

/** Compile-time only: each shared type and its schema describe the same values. */
export type SharedTypeChecks = [
    Assert<Same<z.output<typeof actor>, Actor>>,
    Assert<Same<z.output<typeof emails>, Emails>>,
    Assert<Same<z.output<typeof phones>, Phones>>,
    Assert<Same<z.output<typeof links>, Links>>,
    Assert<Same<z.output<typeof address>, Address>>,
    Assert<Same<z.output<typeof money>, Money>>,
    Assert<Same<z.output<typeof recordTarget>, RecordTarget>>,
    Assert<Same<z.output<typeof richText>, RichText>>,
];

// ─────────────────────────────────────────────────────────────────────────────
// The error envelope (P1-1d). One definition, attached to every operation's `4XX`/`5XX` by the
// document builder, and exactly what `ErrorFilter` sends for every error. Held to the shared
// `ApiErrorBody` type below, so the filter, the document and the web client cannot drift apart.
// ─────────────────────────────────────────────────────────────────────────────

const fieldError = named(
    'FieldError',
    z.object({
        path: z.string().meta({ description: 'Dotted path into the request body.', example: 'emails.primary' }),
        message: z.string(),
    }),
);

export const apiError = named(
    'ApiError',
    z.object({
        statusCode: z.number().int().meta({ example: 404 }),
        code: z.enum(ERROR_CODES).meta({ description: 'Stable machine name; branch on this, never on message.' }),
        message: z.string().meta({ description: 'Human and safe to show.', example: 'person not found' }),
        fieldErrors: z
            .array(fieldError)
            // Absent, never `undefined`: the filter omits the key when there is nothing to say.
            .exactOptional()
            .meta({ description: 'Present when the failure is about specific request fields.' }),
        details: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .exactOptional()
            .meta({
                description:
                    'Facts to act on without parsing the message (counts, limits); present only when the error has some.',
                example: { liveDeals: 2, trashedDeals: 1 },
            }),
        requestId: z.string().meta({ description: 'Also in the X-Request-Id header.', example: EXAMPLE_ID }),
    }),
);

/** Compile-time only: the documented envelope is the shared type. */
export type ApiErrorCheck = Assert<Same<z.output<typeof apiError>, ApiErrorBody>>;

// ─────────────────────────────────────────────────────────────────────────────
// Route decorators. They record what a route returns as an operation extension; the document
// builder moves it onto the 2xx response Nest already generated (from the method and
// `@HttpCode`), so a status is never declared twice. The descriptor type ties the handler's
// return type to the schema at compile time.
// ─────────────────────────────────────────────────────────────────────────────

/** The extension keys the document builder consumes and then removes. */
export const RETURNS_EXTENSION = 'x-byline-returns';

export type ReturnsSpec =
    | { kind: 'json'; schema: string; array: boolean }
    | { kind: 'file'; contentType: string }
    | { kind: 'redirect'; status: RedirectStatus }
    | { kind: 'not-implemented' };

type Handler<T> = Pick<TypedPropertyDescriptor<(...args: never[]) => T | Promise<T>>, 'value'>;
type MethodDecoratorFor<T> = (target: object, key: string | symbol, descriptor: Handler<T>) => void;

function returnsSpec(spec: ReturnsSpec): MethodDecorator {
    return applyDecorators(ApiExtension(RETURNS_EXTENSION, spec));
}

/** The route answers with this JSON body (or an array of it). */
export function Returns<S extends z.ZodType>(schema: S): MethodDecoratorFor<z.output<S>>;
export function Returns<S extends z.ZodType>(schema: [S]): MethodDecoratorFor<z.output<S>[]>;
export function Returns(schema: z.ZodType | [z.ZodType]): MethodDecorator {
    const array = Array.isArray(schema);
    return returnsSpec({ kind: 'json', schema: componentName(array ? schema[0] : schema), array });
}

/** The route streams bytes of this content type (a download or an export). */
export function ReturnsFile(contentType: string): MethodDecorator {
    return returnsSpec({ kind: 'file', contentType });
}

/** The redirect statuses a route may answer with: `302`, or `303` where a GET must lead to a page. */
export type RedirectStatus = 302 | 303;

/** The route answers with a redirect (`302` unless said, and a `Location`), never a body. */
export function Redirects(status: RedirectStatus = 302): MethodDecorator {
    return returnsSpec({ kind: 'redirect', status });
}

/** The route exists and answers `501` until the package that implements it lands. */
export function NotImplementedYet(): MethodDecorator {
    return returnsSpec({ kind: 'not-implemented' });
}
