/**
 * Records: the vocabulary the API and the web app share for people, companies and the fields a
 * workspace adds to them (corpus doc 48 §5; parity ledger PAR-001…006, PAR-073…074, PAR-079).
 * One definition — the DTOs, the policies' companion constants and the UI all read from here.
 */

/** The objects a workspace may add custom fields to. `opportunity` arrives with P1-1b. */
export const RECORD_OBJECTS = ['person', 'company', 'opportunity'] as const;
export type RecordObject = (typeof RECORD_OBJECTS)[number];

/**
 * What a role lets its holder reach: every record in the workspace, or only the records they
 * own (the account-manager rule, doc 48 §5). `own` is applied twice — by the repository's filter
 * and by a restrictive row-level policy underneath it.
 */
export const RECORD_SCOPES = ['all', 'own'] as const;
export type RecordScope = (typeof RECORD_SCOPES)[number];

/**
 * The transaction-local setting that carries an own-scoped caller's member id to the restrictive
 * policies. Unset means the caller sees every owner; the policies read it through
 * `app_owner_member_id()`. Companion to `WORKSPACE_SETTING` and `USER_SETTING`.
 */
export const OWNER_SETTING = 'app.owner_member_id';

/** The value types a custom field can hold. A select's allowed values live in its definition. */
export const CUSTOM_FIELD_TYPES = [
    'text',
    'number',
    'boolean',
    'date',
    'datetime',
    'select',
    'multiselect',
    'url',
    'email',
    'phone',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** A custom field's key: the property name inside a record's `custom` object. */
export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Who, or what, created a record (PAR-003): a member, a machine key, an import, a mailbox sync,
 * or the system itself. Readable on every record, never editable.
 */
export const ACTOR_KINDS = ['member', 'api_key', 'import', 'sync', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
export type Actor = {
    kind: ActorKind;
    /** The member or key id; `null` for the system. */
    id: string | null;
};

/** Page sizes for every list endpoint: the default when the caller says nothing, and the ceiling. */
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;

/** How many rows a text search considers before the page is ordered and cut. */
export const SEARCH_CANDIDATE_LIMIT = 1000;

/**
 * A person's addresses: one primary, any number of others (PAR-001). These composites are type
 * aliases rather than interfaces so they satisfy Prisma's JSON input type, which needs an index
 * signature an interface does not implicitly have.
 */
export type Emails = {
    primary: string | null;
    additional: string[];
};

export type Phone = {
    /** Digits as dialled, without the country code. */
    number: string;
    /** ISO 3166-1 alpha-2, upper case. */
    countryCode: string;
    /** Digits dialled once connected; absent when there is none. */
    extension?: string | undefined;
};

export type Phones = {
    primary: Phone | null;
    additional: Phone[];
};

export type Link = {
    url: string;
    label: string | null;
};

/** The two profile links a person or company carries. */
export type Links = {
    linkedin: Link | null;
    x: Link | null;
};

export type Address = {
    street: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    postalCode: string | null;
};

/**
 * An amount with its currency: the currency's minor unit (cents, pence), exact and integral, and
 * the ISO 4217 code. One representation of money for everything — a deal's amount (PAR-007), a
 * company's ARR — so sums never round and nothing converts. ISO 4217 decides what "minor" means
 * per currency; the client formats.
 */
export type Money = {
    amountMinor: number;
    currency: string;
};

/** The currency an amount takes when a caller names none; a workspace setting (a later package edits it). */
export const DEFAULT_CURRENCY = 'USD';

/**
 * A record a note, task or attachment is attached to (PAR-010/011/016): the object and the row.
 * The objects are exactly the record objects, so a target can be anything a custom field can be
 * on; the `type:id` spelling is how a target travels in a query string.
 */
export type RecordTarget = {
    type: RecordObject;
    id: string;
};

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Rich text as the editor produces it: a ProseMirror/Tiptap document. The API stores it as
 * given and derives plain text from it for search; it never interprets the nodes otherwise.
 */
export type RichText = {
    type: 'doc';
    content?: RichTextNode[] | undefined;
};
export type RichTextNode = {
    type: string;
    text?: string | undefined;
    content?: RichTextNode[] | undefined;
    [key: string]: unknown;
};

/** The largest file an attachment may be, and the content types it may carry. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MIME_ALLOWLIST = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
] as const;

/**
 * A person's contact status (#242), separate from any deal's stage. Derived from what happened unless a member set
 * one by hand (the override), with one exception: `do_not_contact` is exactly "the primary address is on the
 * suppression list". It is never stored as an override (setting it suppresses the address; lifting the suppression
 * is the way out), and nothing outranks it. In order of precedence:
 *
 * - `do_not_contact`: a live suppression for the primary address.
 * - the member's override, when set.
 * - `customer`: the point of contact of a live deal in a won stage.
 * - `engaged`: two or more messages from them, or a meeting with them.
 * - `contacted`: one message from them.
 * - `unresponsive`: `UNRESPONSIVE_AFTER_ATTEMPTS` or more messages sent to them, none answered.
 * - `attempted_contact`: fewer sent, none answered.
 * - `new`: nothing sent yet.
 *
 * Counts, not ages: a status changes only when something happens, so it never goes stale on a list.
 */
export const CONTACT_STATUSES = [
    'new',
    'attempted_contact',
    'contacted',
    'engaged',
    'unresponsive',
    'do_not_contact',
    'customer',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

/** What a member may set by hand. `do_not_contact` is set by suppressing the address (the route does it). */
export type ContactStatusOverride = Exclude<ContactStatus, 'do_not_contact'>;
export const CONTACT_STATUS_OVERRIDES: readonly ContactStatusOverride[] = CONTACT_STATUSES.filter(
    (s): s is ContactStatusOverride => s !== 'do_not_contact',
);

export const CONTACT_STATUS_LABELS: Readonly<Record<ContactStatus, string>> = {
    new: 'New',
    attempted_contact: 'Attempted Contact',
    contacted: 'Contacted',
    engaged: 'Engaged',
    unresponsive: 'Unresponsive',
    do_not_contact: 'Do Not Contact',
    customer: 'Customer',
};

/** Messages sent without a reply before a person reads as `unresponsive` (the migration's SQL uses the same 3). */
export const UNRESPONSIVE_AFTER_ATTEMPTS = 3;
