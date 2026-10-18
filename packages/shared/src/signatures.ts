import type { RichText, RichTextNode } from './records.js';
import { TEMPLATE_BODY_NODES } from './templates.js';

/**
 * Email signatures (#193). A signature belongs to a mailbox: a personal mailbox's is its member's,
 * a pool mailbox's is set by an admin, and a workspace default applies to any mailbox without one
 * of its own. It is the template editor's rich text with images by https URL, rendered by the one
 * serializer and added by the send path after the body — above an outreach email's locked footer.
 */

/** What a signature may contain: the template subset, and images linked by `https:` URL. */
export const SIGNATURE_NODES = [...TEMPLATE_BODY_NODES, 'image'] as const;
/** The stored signature's JSON, serialised: a signature is a few lines. */
export const SIGNATURE_MAX_CHARS = 20_000;
/** An image's width is capped (px); its height follows its aspect. */
export const SIGNATURE_IMAGE_MAX_WIDTH = 600;
export const SIGNATURE_IMAGE_ALT_MAX = 200;

/** What a signature variable reads: the member who sends, or the workspace. */
export type SignatureVariableSource = 'sender' | 'workspace';

export interface SignatureVariable {
    path: string;
    source: SignatureVariableSource;
    label: string;
}

/**
 * Every variable a signature may use. Unlike a template's, none blocks a send: an empty one renders
 * empty, and a line left with nothing on it is left out — a member with no booking link gets no
 * "Book a quick meeting" line, never a broken one.
 */
export const SIGNATURE_VARIABLES = [
    { path: 'sender.fullName', source: 'sender', label: 'Your full name' },
    { path: 'sender.firstName', source: 'sender', label: 'Your first name' },
    { path: 'sender.title', source: 'sender', label: 'Your job title' },
    { path: 'sender.phone', source: 'sender', label: 'Your phone' },
    { path: 'sender.bookingLink', source: 'sender', label: 'Book a quick meeting (Slotline)' },
    { path: 'workspace.name', source: 'workspace', label: 'Workspace name' },
    { path: 'workspace.logo', source: 'workspace', label: 'Company logo' },
] as const satisfies readonly SignatureVariable[];
export type SignatureVariablePath = (typeof SIGNATURE_VARIABLES)[number]['path'];

export const SIGNATURE_LOGO_VARIABLE = 'workspace.logo' satisfies SignatureVariablePath;
export const SIGNATURE_BOOKING_VARIABLE = 'sender.bookingLink' satisfies SignatureVariablePath;
/** How `{{sender.bookingLink}}` reads in an email. */
export const BOOKING_LINK_LABEL = 'Book a quick meeting';

/** The two pre-fills every signature starts with (owner 2026-10-18); an admin can lock each. */
export const SIGNATURE_LOCKABLE = ['logo', 'bookingLink'] as const;
export type SignatureLockable = (typeof SIGNATURE_LOCKABLE)[number];
export const SIGNATURE_LOCK_VARIABLE: Record<SignatureLockable, SignatureVariablePath> = {
    logo: SIGNATURE_LOGO_VARIABLE,
    bookingLink: SIGNATURE_BOOKING_VARIABLE,
};

export function isSignatureVariable(path: string): path is SignatureVariablePath {
    return SIGNATURE_VARIABLES.some((v) => v.path === path);
}

const line = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content });
const variable = (path: SignatureVariablePath): RichTextNode => ({ type: 'variable', attrs: { path } });

/** Where every signature starts — the workspace default and a member's own: name, title, phone, the booking link, the logo. */
export const SIGNATURE_STARTER: RichText = {
    type: 'doc',
    content: [
        line(variable('sender.fullName'), { type: 'hardBreak' }, variable('sender.title')),
        line(variable('sender.phone')),
        line(variable(SIGNATURE_BOOKING_VARIABLE)),
        line(variable(SIGNATURE_LOGO_VARIABLE)),
    ],
};

/** A member's Slotline page is `{baseUrl}/{username}`; the username is set, never guessed from an address. */
export const SLOTLINE_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SIGNATURE_PROFILE_TEXT_MAX = 100;

/** The workspace logo (#193): uploaded once by an admin, served publicly so mail clients can show it. */
export const LOGO_MAX_BYTES = 200 * 1024;
export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'] as const;
/** Every logo is stored as a PNG at most this wide. */
export const LOGO_WIDTH = 300;
/** A replaced logo's address keeps answering this long, for mail already sent. */
export const LOGO_GRACE_DAYS = 30;
/** Where a logo is served, on `APP_URL`: `/api/public/logos/<token>.png`. */
export const LOGO_PUBLIC_PATH = '/api/public/logos';

export interface WorkspaceLogoView {
    url: string;
    width: number;
    height: number;
    uploadedAt: string;
}

/** `GET /settings/signatures`. */
export interface SignatureSettingsView {
    defaultSignature: RichText | null;
    locked: Record<SignatureLockable, boolean>;
    logo: WorkspaceLogoView | null;
    /** What a new signature starts from: the default when there is one, else `SIGNATURE_STARTER`. */
    starter: RichText;
}

export interface SignatureSettingsInput {
    defaultSignature: RichText | null;
    locked: Record<SignatureLockable, boolean>;
}

/** Which signature a mailbox's mail carries. */
export type SignatureApplies = 'own' | 'default' | 'none';

/** `GET /mailboxes/:id/signature`. */
export interface MailboxSignatureView {
    mailboxId: string;
    own: RichText | null;
    /** Off: the workspace default does not apply to this mailbox. */
    useDefault: boolean;
    applies: SignatureApplies;
    /** The signature its mail carries, or null for none. */
    effective: RichText | null;
    /** A pool mailbox's booking page, picked by an admin; null for a personal mailbox, whose member's own applies. */
    bookingLink: string | null;
    locked: Record<SignatureLockable, boolean>;
}

export interface MailboxSignatureInput {
    own: RichText | null;
    useDefault: boolean;
    /** Pool mailboxes only. */
    bookingLink?: string | null | undefined;
}

/** What the `sender.*` variables read for a member. */
export interface SignatureProfileView {
    memberId: string;
    jobTitle: string | null;
    phone: string | null;
    slotlineUsername: string | null;
    /** `{baseUrl}/{username}` while Slotline is set up and a username is set. */
    bookingLink: string | null;
    slotlineConfigured: boolean;
}

export interface SignatureProfileInput {
    jobTitle: string | null;
    phone: string | null;
    slotlineUsername: string | null;
}

/** A signature as it renders in an email: the preview, and what the composer shows. */
export interface RenderedSignature {
    html: string;
    text: string;
}

/** `POST /mailboxes/:id/signature/import`: the mailbox's Gmail signature as a draft to edit and save. */
export interface ImportedSignature {
    signature: RichText | null;
    /** Images the import left out (not https). */
    droppedImages: number;
}
