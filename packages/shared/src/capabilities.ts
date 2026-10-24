/**
 * The capability catalogue (corpus doc 50, preamble; fixed by P0-3). One definition: the API's
 * `@Requires()` decorator, the role editor and the web app's permission-aware controls all read
 * this list. A string that is not here is not a capability, and TypeScript says so.
 */
export const CAPABILITIES = [
    // Records
    'record:read',
    'record:write',
    // Move a record (and the people and deals that go with it) between any two members (OWN-1, FR-CRMS-17).
    // Without it, an owner hands a record on by proposing a transfer the receiver accepts.
    'record:transfer',
    // Export every record, not only your own (GUARD-1, FR-CRMS-21). Without it a CSV holds the caller's own.
    'record:export_all',
    'note:write',
    'task:write',
    // Deals and views
    'deal:read',
    'deal:move',
    'deal:edit',
    'deal:bulk',
    'view:save',
    'view:share',
    'pipeline:configure',
    // Edit the follow-up cadence of each stage and the lead rotation (CADENCE-1): its settings and who is in it.
    'pipeline:cadence',
    // Mail
    'email:send',
    'template:read',
    'template:write',
    'template:send_test',
    'outreach:write',
    // Outreach
    'sequence:write',
    'sequence:enrol',
    // Mailboxes and workspace
    'mailbox:read',
    'mailbox:manage',
    // An integration's reads of synced mail (SVC-1): every message a service inbox holds, bodies included; and how much
    // mail each sender has sent per day — counts only, mail already sent (a scheduled send counts once it goes). In no
    // default role: an admin grants them to the role of the key an integration (NewswireOS) holds.
    'mail:service_read',
    'mail:sent_counts',
    // Guardrails (GUARD-1, FR-CRMS-21): read the events, mark one legitimate, and be told of repeated blocks.
    'guardrail:review',
    // Invoices (INV-1, FR-CRMS-19): verify or reject an invoice by hand (one NewswireOS could not decide, or
    // any when the workspace has no NewswireOS link), and be told when one waits for finance.
    'invoice:verify',
    'workspace:admin',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
    return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The three roles every workspace has from creation. `admin` holds every capability by
 * construction — it has no stored permission rows, so nothing can drift out of it — and a
 * workspace always keeps at least one admin. `member` starts with the defaults below and is
 * editable like any custom role.
 */
export const SYSTEM_ROLES = { admin: 'admin', member: 'member', manager: 'manager' } as const;
export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/**
 * What a new workspace's `manager` role can do until an admin changes it (OWN-1, FR-CRMS-18): a member's
 * defaults, plus moving records between members, acting on many deals at once, exporting every record and
 * reviewing guardrail events (GUARD-1). It is a system role
 * (it exists in every workspace, and keeps its name) that an admin edits like any other.
 */
export const MANAGER_DEFAULT_CAPABILITIES: readonly Capability[] = [
    'record:read',
    'record:write',
    'record:transfer',
    'record:export_all',
    'note:write',
    'task:write',
    'deal:read',
    'deal:move',
    'deal:edit',
    'deal:bulk',
    'view:save',
    'view:share',
    'email:send',
    'template:read',
    'template:write',
    'template:send_test',
    'sequence:write',
    'sequence:enrol',
    'mailbox:read',
    'mailbox:manage',
    'guardrail:review',
    'invoice:verify',
    'pipeline:cadence',
];

/** What a new workspace's `member` role can do until an admin changes it. */
export const MEMBER_DEFAULT_CAPABILITIES: readonly Capability[] = [
    'record:read',
    'record:write',
    'note:write',
    'task:write',
    'deal:read',
    'deal:move',
    'deal:edit',
    'view:save',
    'email:send',
    'template:read',
    'template:write',
    'template:send_test',
    'mailbox:read',
    'mailbox:manage',
];
