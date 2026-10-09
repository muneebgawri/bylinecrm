import {
    CUSTOM_FIELD_KEY_PATTERN,
    CUSTOM_FIELD_TYPES,
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    RECORD_OBJECTS,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { optionsProblem } from './custom-fields/custom-values';

const uuid = z.uuid();
const text = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) => text(max).nullable();
const emailAddress = z.email().max(254);
const url = z.url().max(2048);

/** A registrable host name, lower-cased on the way in; the database checks it stayed that way. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const domain = z.string().trim().toLowerCase().regex(HOSTNAME, 'domain must be a host name like example.com');

const emails = z.object({ primary: emailAddress.nullable(), additional: z.array(emailAddress).max(20) });
const phone = z.object({
    number: z.string().regex(/^[0-9]{3,15}$/, 'digits only, without the country code'),
    countryCode: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, upper case'),
});
const phones = z.object({ primary: phone.nullable(), additional: z.array(phone).max(20) });
const link = z.object({ url, label: nullableText(120) });
const links = z.object({ linkedin: link.nullable(), x: link.nullable() });
const address = z.object({
    street: nullableText(200),
    city: nullableText(120),
    state: nullableText(120),
    country: nullableText(120),
    postalCode: nullableText(20),
});
const money = z.object({
    amount: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'a decimal with at most two places'),
    currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217, upper case'),
});
/** Shape only; the keys and types are checked against the workspace's definitions by the service. */
const custom = z.record(z.string().regex(CUSTOM_FIELD_KEY_PATTERN), z.unknown());
const position = z.number().finite();

const personFields = {
    nameFirst: text(120),
    nameLast: text(120),
    emails,
    phones,
    jobTitle: nullableText(120),
    city: nullableText(120),
    links,
    avatarUrl: url.nullable(),
    position,
    companyId: uuid.nullable(),
    ownerId: uuid.nullable(),
    custom,
};
export class CreatePersonDto extends createZodDto(z.object(personFields).partial()) {}
export class UpdatePersonDto extends createZodDto(z.object(personFields).partial()) {}

const companyFields = {
    name: text(200).min(1),
    domain: domain.nullable(),
    employeeCount: z.number().int().min(0).nullable(),
    arr: money.nullable(),
    address,
    links,
    icp: z.boolean(),
    position,
    ownerId: uuid.nullable(),
    custom,
};
export class CreateCompanyDto extends createZodDto(z.object(companyFields).partial().required({ name: true })) {}
export class UpdateCompanyDto extends createZodDto(z.object(companyFields).partial()) {}

/** Query string of every list endpoint. `sort` is checked against the object's allowlist later. */
export class ListQueryDto extends createZodDto(
    z.object({
        cursor: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
        sort: z
            .string()
            .regex(/^[a-zA-Z]+:(asc|desc)$/, 'sort is field:asc or field:desc')
            .optional(),
        q: text(200).min(1).optional(),
    }),
) {}

const customFieldOptions = z.array(text(120).min(1)).max(200);

export class CreateCustomFieldDto extends createZodDto(
    z
        .object({
            object: z.enum(RECORD_OBJECTS),
            key: z.string().regex(CUSTOM_FIELD_KEY_PATTERN, 'a key is a-z, 0-9 and _, starting with a letter'),
            label: text(120).min(1),
            type: z.enum(CUSTOM_FIELD_TYPES),
            options: customFieldOptions.optional(),
            required: z.boolean().optional(),
            position: position.optional(),
        })
        .superRefine((value, ctx) => {
            const problem = optionsProblem(value.type, value.options ?? []);
            if (problem) ctx.addIssue({ code: 'custom', path: ['options'], message: problem });
        }),
) {}

export class UpdateCustomFieldDto extends createZodDto(
    z.object({
        label: text(120).min(1).optional(),
        options: customFieldOptions.optional(),
        required: z.boolean().optional(),
        position: position.optional(),
    }),
) {}

const queryFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

export class ListCustomFieldsQueryDto extends createZodDto(
    z.object({ object: z.enum(RECORD_OBJECTS).optional(), archived: queryFlag.optional() }),
) {}
