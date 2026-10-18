import {
    SIGNATURE_LOCKABLE,
    type ImportedSignature,
    type MailboxSignatureView,
    type RenderedSignature,
    type SignatureProfileView,
    type SignatureSettingsView,
    type SlotlineEventTypeView,
    type WorkspaceLogoView,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named, richText } from '../openapi/responses';

/** Email signatures (#193) as the API returns them. */

const locked = z
    .object(
        Object.fromEntries(SIGNATURE_LOCKABLE.map((lock) => [lock, z.boolean()])) as Record<
            (typeof SIGNATURE_LOCKABLE)[number],
            z.ZodBoolean
        >,
    )
    .meta({ description: 'Pre-fills an admin has locked into every signature.' });

export const workspaceLogoView = named(
    'WorkspaceLogo',
    z.object({
        url: z.string().meta({ description: 'Public and unguessable; mail clients load it without a sign-in.' }),
        width: z.number().int(),
        height: z.number().int(),
        uploadedAt: z.iso.datetime(),
    }),
);

export const signatureSettingsView = named(
    'SignatureSettings',
    z.object({
        defaultSignature: richText.nullable(),
        locked,
        logo: workspaceLogoView.nullable(),
        starter: richText.meta({ description: 'What a new signature starts from.' }),
    }),
);

export const mailboxSignatureView = named(
    'MailboxSignature',
    z.object({
        mailboxId: id,
        own: richText.nullable(),
        useDefault: z.boolean(),
        applies: z.enum(['own', 'default', 'none']),
        effective: richText.nullable().meta({ description: 'The signature the mailbox’s mail carries.' }),
        bookingLink: z.string().nullable(),
        locked,
    }),
);

export const signatureProfileView = named(
    'SignatureProfile',
    z.object({
        memberId: id,
        name: z.string().nullable(),
        jobTitle: z.string().nullable(),
        phone: z.string().nullable(),
        slotlineUsername: z.string().nullable(),
        bookingLink: z.string().nullable(),
        slotlineConfigured: z.boolean(),
        slotlineKey: z
            .object({ last4: z.string() })
            .nullable()
            .meta({ description: 'The member’s own Slotline API key: set or not, and its last four only.' }),
        slotlineEvent: z
            .object({ slug: z.string(), title: z.string() })
            .nullable()
            .meta({ description: 'The event type “Book a quick meeting” opens; null opens the member’s page.' }),
    }),
);

export const slotlineEventTypeView = named(
    'SlotlineEventType',
    z.object({
        slug: z.string(),
        title: z.string(),
        lengthInMinutes: z.number().int().nullable(),
        hidden: z.boolean().meta({ description: 'Not on the member’s public page, but bookable by its link.' }),
        bookingLink: z.string(),
    }),
);

export const renderedSignature = named('RenderedSignature', z.object({ html: z.string(), text: z.string() }));

export const importedSignature = named(
    'ImportedSignature',
    z.object({
        signature: richText.nullable(),
        droppedImages: z.number().int().meta({ description: 'Images the import left out (not https).' }),
    }),
);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** Compile-time only: each shared type and its schema describe the same values. */
export type SignatureTypeChecks = [
    Assert<Same<z.output<typeof workspaceLogoView>, WorkspaceLogoView>>,
    Assert<Same<z.output<typeof signatureSettingsView>, SignatureSettingsView>>,
    Assert<Same<z.output<typeof mailboxSignatureView>, MailboxSignatureView>>,
    Assert<Same<z.output<typeof signatureProfileView>, SignatureProfileView>>,
    Assert<Same<z.output<typeof renderedSignature>, RenderedSignature>>,
    Assert<Same<z.output<typeof importedSignature>, ImportedSignature>>,
    Assert<Same<z.output<typeof slotlineEventTypeView>, SlotlineEventTypeView>>,
];
