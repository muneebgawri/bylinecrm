import {
    CUSTOM_VARIABLE_SOURCES,
    TEMPLATE_KINDS,
    TEMPLATE_VARIABLE_SOURCES,
    type MailSettings,
    type PostalAddress,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { actor, dateTime, id, named, page, richText } from '../openapi/responses';

/** Email templates, their renders and the workspace's mail settings (P2-4), as the API returns them. */

export const emailTemplateView = named(
    'EmailTemplate',
    z.object({
        id,
        name: z.string(),
        kind: z.enum(TEMPLATE_KINDS),
        subject: z.string().meta({ description: 'Plain text; variables are `{{path}}` tokens.' }),
        body: richText.meta({ description: 'The template subset of rich text; variables are `variable` nodes.' }),
        version: z.number().int().meta({ description: 'Name it when you PATCH (body `version` or `If-Match`).' }),
        createdBy: actor,
        updatedBy: actor,
        createdAt: dateTime,
        updatedAt: dateTime,
        deletedAt: dateTime.nullable(),
    }),
);
export const emailTemplatePage = named('EmailTemplatePage', page(emailTemplateView));

export const renderedEmail = named(
    'RenderedEmail',
    z.object({
        subject: z.string(),
        html: z.string(),
        text: z.string(),
        missing: z.array(z.string()).meta({
            description:
                'Variables with no value for this recipient (and `workspace.postal_address` for an outreach template with none set), in order of first use. Each is marked in `html` (`data-missing-variable`) and kept as `{{path}}` in `subject` and `text`; nothing is ever rendered blank.',
        }),
        sendable: z.boolean().meta({ description: 'False whenever `missing` is not empty.' }),
    }),
);

const templateVariable = named(
    'TemplateVariable',
    z.object({
        path: z.string().meta({ example: 'person.firstName' }),
        source: z.enum(TEMPLATE_VARIABLE_SOURCES),
        label: z.string(),
        type: z.string().meta({
            description: '`text`, `email` or `money` for a standard variable; the custom field’s type otherwise.',
        }),
        optional: z
            .boolean()
            .meta({ description: 'Renders empty instead of blocking the send (only `sender.signature`).' }),
    }),
);
export const templateVariables = named(
    'TemplateVariables',
    z.object({
        standard: z.array(templateVariable),
        custom: z.array(templateVariable.extend({ source: z.enum(CUSTOM_VARIABLE_SOURCES) })),
    }),
);

const postalAddress = named(
    'PostalAddress',
    z.object({
        line1: z.string(),
        line2: z.string().nullable(),
        city: z.string(),
        region: z.string().nullable(),
        postalCode: z.string(),
        country: z.string().meta({ example: 'US' }),
    }),
);
export const mailSettingsView = named(
    'MailSettings',
    z.object({
        postalAddress: postalAddress.nullable(),
        defaultSenderName: z.string().nullable(),
        unsubscribeFooterText: z.string(),
    }),
);

export type EmailTemplateView = z.output<typeof emailTemplateView>;
export type RenderedEmail = z.output<typeof renderedEmail>;
export type TemplateVariablesView = z.output<typeof templateVariables>;
export type MailSettingsView = z.output<typeof mailSettingsView>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** Compile-time only: the documented settings are the shared types. */
export type MailSettingsChecks = [
    Assert<Same<z.output<typeof postalAddress>, PostalAddress>>,
    Assert<Same<MailSettingsView, MailSettings>>,
];
