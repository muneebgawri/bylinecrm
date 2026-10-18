import type { RichText } from './records.js';

/**
 * Email templates (P2-4; doc 48 FR-CRMS-3, FR-CRMS-7, FR-CRMS-12; doc 50 §C). The vocabulary the
 * API validates and renders with and the template editor (P2-UI-2) offers: kinds, the variable
 * registry, the rich-text subset a template body may use, and the workspace's mail settings.
 */

/** `personal` is 1:1 mail; `outreach` is mail a sequence sends, and carries the locked footer. */
export const TEMPLATE_KINDS = ['personal', 'outreach'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_NAME_MAX = 200;
export const TEMPLATE_SUBJECT_MAX = 300;
/** The stored body's JSON, serialised: a template is a few paragraphs, not a document. */
export const TEMPLATE_BODY_MAX_CHARS = 100_000;

/**
 * The rich-text a template body may contain. The API refuses anything else on save, and the
 * renderer drops anything else again on the way out (defence in depth), so an email can only ever
 * carry these. Headings are levels 2 and 3 only: a subject line is the email's level 1.
 */
export const TEMPLATE_BODY_NODES = [
    'paragraph',
    'heading',
    'bulletList',
    'orderedList',
    'listItem',
    'hardBreak',
    'text',
    'variable',
] as const;
export const TEMPLATE_BODY_MARKS = ['bold', 'italic', 'link'] as const;
export const TEMPLATE_HEADING_LEVELS = [2, 3] as const;
/** Link targets an email may carry; `javascript:` and every other scheme are refused. */
export const TEMPLATE_LINK_SCHEMES = ['https:', 'mailto:'] as const;

/** Where a variable's value comes from. `deal` is the opportunity the email is about, when there is one. */
export const TEMPLATE_VARIABLE_SOURCES = ['person', 'company', 'deal', 'sender'] as const;
export type TemplateVariableSource = (typeof TEMPLATE_VARIABLE_SOURCES)[number];

export type TemplateVariableType = 'text' | 'email' | 'money';

export interface TemplateVariable {
    path: string;
    source: TemplateVariableSource;
    type: TemplateVariableType;
    label: string;
    /**
     * Renders empty when it has no value instead of blocking the send. Exactly one variable is
     * optional — `sender.signature`, which places the sending mailbox's signature (#193) and is
     * nothing when none applies; every other empty variable makes the render unsendable (FR-CRMS-3).
     */
    optional?: true;
}

/** Every standard variable a template may use. One registry: the API validates and renders against it, the editor lists it. */
export const TEMPLATE_VARIABLES = [
    { path: 'person.firstName', source: 'person', type: 'text', label: 'First name' },
    { path: 'person.lastName', source: 'person', type: 'text', label: 'Last name' },
    { path: 'person.fullName', source: 'person', type: 'text', label: 'Full name' },
    { path: 'person.email', source: 'person', type: 'email', label: 'Email' },
    { path: 'person.jobTitle', source: 'person', type: 'text', label: 'Job title' },
    { path: 'person.city', source: 'person', type: 'text', label: 'City' },
    { path: 'company.name', source: 'company', type: 'text', label: 'Company name' },
    { path: 'company.domain', source: 'company', type: 'text', label: 'Company domain' },
    { path: 'deal.name', source: 'deal', type: 'text', label: 'Deal name' },
    { path: 'deal.amount', source: 'deal', type: 'money', label: 'Deal amount' },
    { path: 'sender.firstName', source: 'sender', type: 'text', label: 'Your first name' },
    { path: 'sender.fullName', source: 'sender', type: 'text', label: 'Your full name' },
    { path: 'sender.signature', source: 'sender', type: 'text', label: 'Your signature (placed here)', optional: true },
] as const satisfies readonly TemplateVariable[];
export type StandardVariablePath = (typeof TEMPLATE_VARIABLES)[number]['path'];

/**
 * A custom field as a variable: `<source>.custom.<key>`, where the source is the record the field
 * is defined on. The object prefix is part of the path because the same key may be defined on a
 * person and a company; `custom.<key>` alone would be ambiguous.
 */
export const CUSTOM_VARIABLE_SOURCES = ['person', 'company', 'deal'] as const;
export type CustomVariableSource = (typeof CUSTOM_VARIABLE_SOURCES)[number];
const CUSTOM_VARIABLE_PATTERN = /^(person|company|deal)\.custom\.([a-z][a-z0-9_]{0,63})$/;

export type ParsedVariablePath =
    | { kind: 'standard'; variable: (typeof TEMPLATE_VARIABLES)[number] }
    | { kind: 'custom'; source: CustomVariableSource; key: string };

/** What a variable path names, or `null` when it names nothing in the registry's grammar. */
export function parseVariablePath(path: string): ParsedVariablePath | null {
    const variable = TEMPLATE_VARIABLES.find((v) => v.path === path);
    if (variable) return { kind: 'standard', variable };
    const match = CUSTOM_VARIABLE_PATTERN.exec(path);
    if (match) return { kind: 'custom', source: match[1] as CustomVariableSource, key: match[2]! };
    return null;
}

/** A `{{ path }}` token in a subject line. The body carries variables as nodes, never as text. */
export const TEMPLATE_SUBJECT_TOKEN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * The placeholder an outreach email's unsubscribe link carries until the send path (P3) replaces
 * it with the recipient's one-click URL. Not a variable: it is never missing, and a template
 * cannot name it.
 */
export const UNSUBSCRIBE_URL_PLACEHOLDER = '{{unsubscribe_url}}';
export const UNSUBSCRIBE_LINK_LABEL = 'Unsubscribe';
/** What `missing` names when an outreach template is rendered and the workspace has no postal address. */
export const MISSING_POSTAL_ADDRESS = 'workspace.postal_address';

/** The locale a rendered email formats amounts in; the recipient's locale is not known. */
export const TEMPLATE_RENDER_LOCALE = 'en-US';

/** The postal address outreach mail must carry (FR-CRMS-12). `country` is ISO 3166-1 alpha-2. */
export interface PostalAddress {
    line1: string;
    line2: string | null;
    city: string;
    region: string | null;
    postalCode: string;
    country: string;
}

/**
 * A country's name for its ISO 3166-1 alpha-2 code, from the runtime's region data
 * (`Intl.DisplayNames`), in `locale`; the code itself when the runtime does not know it (#76).
 */
export function countryName(code: string, locale = 'en'): string {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
}

/**
 * A postal address as one line, as it reads at the foot of an outreach email (FR-CRMS-12): the parts
 * that are set, comma-separated, the country by name (#76). One function for the API's render and the
 * web's preview, so the two cannot disagree. English: the footer is rendered once for every recipient.
 */
export function formatPostalAddress(address: PostalAddress, locale = 'en'): string {
    return [
        address.line1,
        address.line2,
        address.city,
        address.region,
        address.postalCode,
        countryName(address.country, locale),
    ]
        .filter(Boolean)
        .join(', ');
}

export const DEFAULT_UNSUBSCRIBE_FOOTER_TEXT = 'You are receiving this email because we thought it would interest you.';
export const MAIL_SETTINGS_TEXT_MAX = 300;

/** The workspace's mail settings; a workspace that never saved them reads these defaults. */
export interface MailSettings {
    postalAddress: PostalAddress | null;
    defaultSenderName: string | null;
    unsubscribeFooterText: string;
}

/** A template as stored and as the API returns it. */
export interface EmailTemplateBody {
    name: string;
    kind: TemplateKind;
    subject: string;
    body: RichText;
}
