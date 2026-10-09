/**
 * The capability catalogue (corpus doc 50, preamble; fixed by P0-3). One definition: the API's
 * `@Requires()` decorator, the role editor and the web app's permission-aware controls all read
 * this list. A string that is not here is not a capability, and TypeScript says so.
 */
export const CAPABILITIES = [
    // Records
    'record:read',
    'record:write',
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
    'workspace:admin',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
    return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The two roles every workspace has from creation. `admin` holds every capability by
 * construction — it has no stored permission rows, so nothing can drift out of it — and a
 * workspace always keeps at least one admin. `member` starts with the defaults below and is
 * editable like any custom role.
 */
export const SYSTEM_ROLES = { admin: 'admin', member: 'member' } as const;
export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

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
