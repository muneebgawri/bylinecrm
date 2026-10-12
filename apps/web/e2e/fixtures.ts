import {
    CAPABILITIES,
    DEFAULT_PIPELINE_NAME,
    DEFAULT_STAGES,
    SYSTEM_ROLES,
    type Capability,
    type RecordObject,
} from '@bylinecrm/shared';
import type {
    ApiKeyView,
    AuthProvidersView,
    InvitePreviewView,
    PlatformAccessView,
    PlatformWorkspaceView,
    BlocklistEntryView,
    RegionPolicyChangeView,
    RegionPolicyEntryView,
    EmailVerificationSettingsView,
    EnrichmentHistoryView,
    EnrichmentSettingsView,
    SuppressionView,
    SendingPoolView,
    TwentyImportOverviewView,
    TwentyImportRunView,
    UnsubscribeStatusView,
    AttachmentView,
    BoardView,
    CompanyView,
    CustomFieldView,
    EmailTemplateView,
    GoogleOAuthClientStatusView,
    GoogleOAuthClientView,
    InviteView,
    MailboxSyncView,
    MailboxView,
    MailOutboundView,
    MailThreadView,
    MailSettingsView,
    MembershipSummary,
    MemberSummaryView,
    MemberView,
    NoteView,
    OpportunityView,
    NotePage,
    PersonPage,
    PersonView,
    PipelineView,
    RoleView,
    RuleView,
    SavedView,
    StageHistoryEntry,
    StageView,
    TaskView,
    TemplateVariablesView,
    TimelineActivityView,
    ProfileView,
    UserView,
    WorkspaceView,
    SequenceEnrolmentView,
    SequenceView,
} from '../src/api/types';

/**
 * The data the route gate renders every page with. It is fixed — ids, names, amounts and every
 * timestamp — so a screenshot is the same on every run; it is typed against the web app's own
 * view types, so a shape the app stops understanding fails `tsc` before it fails a page.
 *
 * The clock in the browser is frozen at `FIXED_NOW` (routes.spec.ts), so "4 days in stage" and
 * "2 hours ago" read the same every time too.
 */
export const FIXED_NOW = Date.parse('2026-10-09T09:00:00.000Z');
const at = (hoursAgo: number) => new Date(FIXED_NOW - hoursAgo * 3_600_000).toISOString();

/** Example ids, by kind. Record routes are visited with these (see states.ts). */
export const IDS = {
    workspace: '0b1e0000-0000-4000-8000-000000000001',
    secondWorkspace: '0b1e0000-0000-4000-8000-000000000002',
    user: '0b1e0000-0000-4000-8000-0000000000a1',
    member: '0b1e0000-0000-4000-8000-0000000000b1',
    secondMember: '0b1e0000-0000-4000-8000-0000000000b2',
    adminRole: '0b1e0000-0000-4000-8000-0000000000c1',
    memberRole: '0b1e0000-0000-4000-8000-0000000000c2',
    person: '0b1e0000-0000-4000-8000-0000000000d1',
    secondPerson: '0b1e0000-0000-4000-8000-0000000000d2',
    company: '0b1e0000-0000-4000-8000-0000000000e1',
    secondCompany: '0b1e0000-0000-4000-8000-0000000000e2',
    deal: '0b1e0000-0000-4000-8000-0000000000f1',
    secondDeal: '0b1e0000-0000-4000-8000-0000000000f2',
    thirdDeal: '0b1e0000-0000-4000-8000-0000000000f3',
    fourthDeal: '0b1e0000-0000-4000-8000-0000000000f4',
    pipeline: '0b1e0000-0000-4000-8000-000000000101',
    view: '0b1e0000-0000-4000-8000-000000000201',
    template: '0b1e0000-0000-4000-8000-0000000007a1',
    outreachTemplate: '0b1e0000-0000-4000-8000-0000000007a2',
    mailbox: '0b1e0000-0000-4000-8000-0000000008a1',
    poolMailbox: '0b1e0000-0000-4000-8000-0000000008a2',
    sendingDomain: '0b1e0000-0000-4000-8000-0000000008a3',
    blockedDomain: '0b1e0000-0000-4000-8000-0000000008b1',
    suppressedUnsubscribe: '0b1e0000-0000-4000-8000-0000000009a1',
    suppressedBounce: '0b1e0000-0000-4000-8000-0000000009a2',
    suppressedManual: '0b1e0000-0000-4000-8000-0000000009a3',
    thread: '0b1e0000-0000-4000-8000-0000000008c1',
    mailMessage: '0b1e0000-0000-4000-8000-0000000008c2',
    secondMailMessage: '0b1e0000-0000-4000-8000-0000000008c3',
    scheduledSend: '0b1e0000-0000-4000-8000-0000000008d1',
    sequence: '0b1e0000-0000-4000-8000-000000000a01',
    enrolment: '0b1e0000-0000-4000-8000-000000000a11',
    stoppedEnrolment: '0b1e0000-0000-4000-8000-000000000a12',
} as const;

const stageId = (index: number) => `0b1e0000-0000-4000-8000-0000000003${String(index).padStart(2, '0')}`;
const member = { kind: 'member' as const, id: IDS.member };

export const user: UserView = { id: IDS.user, email: 'kate.morgan@example.com', emailVerified: true };
/** A confirmed name, so the gate's pages are not covered by the first-sign-up prompt. */
export const profile: ProfileView = { email: user.email, displayName: 'Kate Morgan', completed: true };

/** Two workspaces, so `/workspaces` shows its picker instead of redirecting to the only one. */
export const workspaces: WorkspaceView[] = [
    { id: IDS.workspace, slug: 'pinion', name: 'Pinion Partners' },
    { id: IDS.secondWorkspace, slug: 'demo', name: 'Demo workspace' },
];

/**
 * Sign-up as a locked-down server has it (P0-14): closed, so the sign-in page offers no "Create a
 * workspace" and `/sign-up` explains how to get in. The person is a platform admin, so the picker
 * links to the platform page and that page renders its list.
 */
export const providers: AuthProvidersView = { providers: ['google'], signup: 'closed' };
export const platformAccess: PlatformAccessView = { platformAdmin: true, signupMode: 'closed' };
export const platformWorkspaces: PlatformWorkspaceView[] = [
    {
        id: IDS.workspace,
        slug: 'pinion',
        name: 'Pinion Partners',
        createdAt: at(24 * 30),
        memberCount: 4,
        pendingInvites: [],
    },
    {
        id: IDS.secondWorkspace,
        slug: 'demo',
        name: 'Demo workspace',
        createdAt: at(26),
        memberCount: 0,
        pendingInvites: [{ email: 'owner@client.example', expiresAt: at(-24 * 6) }],
    },
];

/** The token the invitation-accept state opens `/sign-up?invite=` with, and what it is for. */
export const INVITE_TOKEN = 'gate-invite-token';
/** The secret in a mailed verification or reset link the gate opens (#93). */
export const LINK_TOKEN = 'gate-link-token';
export const invitePreview: InvitePreviewView = {
    email: 'owner@client.example',
    workspaceName: 'Demo workspace',
    expiresAt: at(-24 * 6),
};

/** An admin: every capability, so every permission-gated control renders and is checked. */
export const membership: MembershipSummary = {
    workspaceId: IDS.workspace,
    memberId: IDS.member,
    apiKeyId: null,
    userId: IDS.user,
    roleId: IDS.adminRole,
    roleName: SYSTEM_ROLES.admin,
    recordScope: 'all',
    capabilities: [...CAPABILITIES],
};

export const roles: RoleView[] = [
    {
        id: IDS.adminRole,
        name: SYSTEM_ROLES.admin,
        isSystem: true,
        recordScope: 'all',
        capabilities: [...CAPABILITIES],
    },
    {
        id: IDS.memberRole,
        name: SYSTEM_ROLES.member,
        isSystem: true,
        recordScope: 'all',
        capabilities: ['record:read', 'record:write'] satisfies Capability[],
    },
];

export const members: MemberView[] = [
    {
        id: IDS.member,
        userId: IDS.user,
        email: user.email,
        displayName: 'Kate Morgan',
        roleId: IDS.adminRole,
        roleName: SYSTEM_ROLES.admin,
        createdAt: at(24 * 30),
    },
    {
        id: IDS.secondMember,
        userId: '0b1e0000-0000-4000-8000-0000000000a2',
        email: 'sam.okafor@example.com',
        displayName: 'Sam Okafor',
        roleId: IDS.memberRole,
        roleName: SYSTEM_ROLES.member,
        createdAt: at(24 * 12),
    },
];

export const membersSummary: MemberSummaryView[] = [
    { memberId: IDS.member, name: 'Kate Morgan' },
    { memberId: IDS.secondMember, name: 'Sam Okafor' },
];

export const apiKeys: ApiKeyView[] = [
    {
        id: '0b1e0000-0000-4000-8000-000000000401',
        name: 'NewswireOS sync',
        prefix: 'blc_x7k2m9qa',
        roleId: IDS.memberRole,
        createdAt: at(24 * 7),
        lastUsedAt: at(2),
        revokedAt: null,
    },
];

export const invites: InviteView[] = [
    {
        id: '0b1e0000-0000-4000-8000-000000000501',
        email: 'daniel.kim@example.com',
        roleId: IDS.memberRole,
        expiresAt: at(-24 * 6),
        acceptedAt: null,
    },
];

const noLinks = { linkedin: null, x: null };
/** Related records by name, as the API embeds them on a row (P1-4a). */
const ownerOf = (memberId: string) => membersSummary.find((m) => m.memberId === memberId) ?? null;
const companyRef = (id: string) => ({ id, name: id === IDS.company ? 'Acme Corp' : 'Initech' });
const personRef = (id: string) => ({ id, name: id === IDS.person ? 'Dana Reyes' : 'Sam Okafor' });
const noAddress = { street: null, city: null, state: null, country: null, postalCode: null };
const created = (hoursAgo: number) => ({
    createdBy: member,
    deletedAt: null,
    createdAt: at(hoursAgo),
    updatedAt: at(hoursAgo / 2),
});

export const companies: CompanyView[] = [
    {
        id: IDS.company,
        name: 'Acme Corp',
        domain: 'acme.example',
        logoUrl: null,
        employeeCount: 240,
        arr: { amountMinor: 1_200_000_00, currency: 'USD' },
        address: { ...noAddress, city: 'Austin', country: 'US' },
        links: noLinks,
        icp: true,
        position: 0,
        ownerId: IDS.member,
        owner: ownerOf(IDS.member),
        custom: {},
        ...created(24 * 14),
    },
    {
        id: IDS.secondCompany,
        name: 'Initech',
        domain: 'initech.example',
        logoUrl: null,
        employeeCount: 1800,
        arr: null,
        address: noAddress,
        links: noLinks,
        icp: false,
        position: 1,
        ownerId: IDS.secondMember,
        owner: ownerOf(IDS.secondMember),
        custom: {},
        ...created(24 * 9),
    },
];

export const people: PersonView[] = [
    {
        id: IDS.person,
        nameFirst: 'Dana',
        nameLast: 'Reyes',
        emails: { primary: 'dana@acme.example', additional: [] },
        phones: { primary: { number: '5125550198', countryCode: 'US' }, additional: [] },
        jobTitle: 'Head of Comms',
        source: 'Agency list Q3',
        country: 'US',
        city: 'Austin',
        links: { linkedin: { url: 'https://www.linkedin.com/in/danareyes', label: null }, x: null },
        avatarUrl: null,
        position: 0,
        companyId: IDS.company,
        ownerId: IDS.member,
        company: companyRef(IDS.company),
        owner: ownerOf(IDS.member),
        custom: {},
        ...created(24 * 14),
    },
    {
        id: IDS.secondPerson,
        nameFirst: 'Sam',
        nameLast: 'Okafor',
        emails: { primary: 'sam@initech.example', additional: ['s.okafor@initech.example'] },
        phones: { primary: null, additional: [] },
        jobTitle: 'VP Marketing',
        source: 'Agency list Q3',
        country: 'US',
        city: null,
        links: noLinks,
        avatarUrl: null,
        position: 1,
        companyId: IDS.secondCompany,
        ownerId: IDS.secondMember,
        company: companyRef(IDS.secondCompany),
        owner: ownerOf(IDS.secondMember),
        custom: {},
        ...created(24 * 9),
    },
];

export const stages: StageView[] = DEFAULT_STAGES.map((stage, index) => ({
    id: stageId(index),
    pipelineId: IDS.pipeline,
    name: stage.name,
    position: index,
    probability: stage.probability,
    kind: stage.kind,
    daysThreshold: stage.kind === 'open' ? 14 : null,
    colour: stage.colour,
}));

export const pipeline: PipelineView = {
    id: IDS.pipeline,
    name: DEFAULT_PIPELINE_NAME,
    isDefault: true,
    position: 0,
    stages,
    createdAt: at(24 * 30),
    updatedAt: at(24 * 30),
};

const deal = (
    id: string,
    name: string,
    stageIndex: number,
    amountMinor: number,
    daysInStage: number,
    companyId: string,
    pointOfContactId: string,
): OpportunityView => ({
    id,
    name,
    pipelineId: IDS.pipeline,
    stageId: stageId(stageIndex),
    stageEnteredAt: at(daysInStage * 24),
    daysInStage,
    closedAt: null,
    lostReason: null,
    amount: { amountMinor, currency: 'USD' },
    currency: 'USD',
    closeDate: '2026-10-31',
    probability: DEFAULT_STAGES[stageIndex]?.probability ?? null,
    position: 0,
    ownerId: IDS.member,
    pointOfContactId,
    companyId,
    company: companyRef(companyId),
    pointOfContact: personRef(pointOfContactId),
    owner: ownerOf(IDS.member),
    custom: {},
    ...created(24 * 20),
});

export const deals: OpportunityView[] = [
    deal(IDS.deal, 'Series B PR', 2, 12_000_00, 4, IDS.company, IDS.person),
    deal(IDS.secondDeal, 'IPO wire', 3, 11_000_00, 1, IDS.secondCompany, IDS.secondPerson),
    deal(IDS.thirdDeal, 'Product launch', 1, 6_500_00, 21, IDS.company, IDS.person),
    // The first stage holds a deal, so a phone's board — which opens on the first stage — shows a
    // card for the gate's above-the-fold check to measure (states.ts).
    deal(IDS.fourthDeal, 'Annual plan', 0, 4_500_00, 2, IDS.secondCompany, IDS.secondPerson),
];

export const board: BoardView = {
    pipeline,
    columns: stages.map((stage) => {
        const inStage = deals.filter((d) => d.stageId === stage.id);
        const total = inStage.reduce((sum, d) => sum + (d.amount?.amountMinor ?? 0), 0);
        return {
            stage,
            count: inStage.length,
            amountMinorByCurrency: inStage.length ? { USD: total } : {},
            deals: inStage,
            hasMore: false,
        };
    }),
};

export const rules: RuleView[] = [
    {
        id: '0b1e0000-0000-4000-8000-000000000601',
        pipelineId: IDS.pipeline,
        event: 'email.replied',
        toStageId: stageId(2),
        allowBackward: false,
        enabled: true,
    },
];

export const history: StageHistoryEntry[] = [
    {
        id: '0b1e0000-0000-4000-8000-000000000701',
        fromStageId: stageId(1),
        fromStageName: DEFAULT_STAGES[1]!.name,
        toStageId: stageId(2),
        toStageName: DEFAULT_STAGES[2]!.name,
        enteredAt: at(4 * 24),
        // A rule-made move names its rule; the API's actor carries the rule's id, never null.
        actor: { kind: 'rule', id: '0b1e0000-0000-4000-8000-000000000601' },
        reason: 'rule',
    },
    {
        id: '0b1e0000-0000-4000-8000-000000000702',
        fromStageId: null,
        fromStageName: null,
        toStageId: stageId(1),
        toStageName: DEFAULT_STAGES[1]!.name,
        enteredAt: at(20 * 24),
        actor: member,
        reason: 'manual',
    },
];

export const savedViews = (object: RecordObject): SavedView[] => [
    {
        id: IDS.view,
        object,
        name: 'My open items',
        icon: null,
        ownerMemberId: IDS.member,
        isShared: true,
        filter: null,
        sorts: [],
        columns: [],
        groupBy: null,
        position: 0,
        createdAt: at(24 * 3),
        updatedAt: at(24 * 3),
    },
];

export const customFields = (object: RecordObject): CustomFieldView[] =>
    object === 'person'
        ? [
              {
                  id: '0b1e0000-0000-4000-8000-000000000801',
                  object,
                  key: 'beat',
                  label: 'Beat',
                  type: 'text',
                  options: [],
                  required: false,
                  position: 0,
                  archivedAt: null,
                  createdAt: at(24 * 30),
                  updatedAt: at(24 * 30),
              },
          ]
        : [];

/** The archived definitions of an object: one on people, so the collapsed "Archived fields" section is visited. */
export const archivedCustomFields = (object: RecordObject): CustomFieldView[] =>
    object === 'person'
        ? [
              {
                  id: '0b1e0000-0000-4000-8000-000000000802',
                  object,
                  key: 'region',
                  label: 'Region',
                  type: 'text',
                  options: [],
                  required: false,
                  position: 1,
                  archivedAt: at(24 * 3),
                  createdAt: at(24 * 60),
                  updatedAt: at(24 * 3),
              },
          ]
        : [];

const doc = (text: string) => ({
    type: 'doc' as const,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

export const notes: NoteView[] = [
    {
        id: '0b1e0000-0000-4000-8000-000000000901',
        title: 'Met at FinCon',
        body: doc('Interested in EU distribution for Q4; the CFO signs off on anything above $10k.'),
        bodyText: 'Interested in EU distribution for Q4; the CFO signs off on anything above $10k.',
        targets: [{ type: 'person', id: IDS.person }],
        authorId: IDS.member,
        ...created(24 * 9),
    },
];

export const tasks: TaskView[] = [
    {
        id: '0b1e0000-0000-4000-8000-000000000a01',
        title: 'Send the pricing deck',
        body: doc('Attach the EU distribution sheet.'),
        bodyText: 'Attach the EU distribution sheet.',
        status: 'todo',
        dueAt: at(-24),
        assigneeId: IDS.member,
        completedAt: null,
        targets: [{ type: 'person', id: IDS.person }],
        ...created(24 * 2),
    },
];

export const attachments: AttachmentView[] = [
    {
        id: '0b1e0000-0000-4000-8000-000000000b01',
        name: 'distribution-list.pdf',
        mime: 'application/pdf',
        sizeBytes: 482_113,
        target: { type: 'person', id: IDS.person },
        authorId: IDS.member,
        ...created(24 * 3),
    },
];

export const timeline: TimelineActivityView[] = [
    {
        id: '0b1e0000-0000-4000-8000-000000000c04',
        target: { type: 'person', id: IDS.person },
        kind: 'linked-email.received',
        happenedAt: at(2),
        actor: { kind: 'sync', id: null },
        properties: {
            linked: { type: 'email', id: IDS.secondMailMessage, name: 'Re: Distribution options' },
            email: {
                direction: 'inbound',
                subject: 'Re: Distribution options',
                snippet: 'Thanks — the list looks right.',
                from: 'dana@acme.example',
                threadId: IDS.thread,
                mailboxId: IDS.mailbox,
            },
        },
        linked: { type: 'email', id: IDS.secondMailMessage },
        createdAt: at(2),
    },
    {
        id: '0b1e0000-0000-4000-8000-000000000c01',
        target: { type: 'opportunity', id: IDS.deal },
        kind: 'deal.stage_changed',
        happenedAt: at(4 * 24),
        // A rule-made move names its rule; the API's actor carries the rule's id, never null.
        actor: { kind: 'rule', id: '0b1e0000-0000-4000-8000-000000000601' },
        properties: { diff: { stageId: { from: stageId(1), to: stageId(2) } } },
        linked: null,
        createdAt: at(4 * 24),
    },
    {
        id: '0b1e0000-0000-4000-8000-000000000c02',
        target: { type: 'person', id: IDS.person },
        kind: 'linked-note.created',
        happenedAt: at(9 * 24),
        actor: member,
        properties: { displayName: 'Met at FinCon' },
        linked: { type: 'note', id: '0b1e0000-0000-4000-8000-000000000901' },
        createdAt: at(9 * 24),
    },
    {
        id: '0b1e0000-0000-4000-8000-000000000c03',
        target: { type: 'person', id: IDS.person },
        kind: 'person.created',
        happenedAt: at(14 * 24),
        actor: member,
        properties: {},
        linked: null,
        createdAt: at(14 * 24),
    },
];

/** A cursor page (notes, tasks, timeline): the generated page shape with these rows. */
export const page = <T>(items: T[]): Omit<NotePage, 'items'> & { items: T[] } => ({ items, nextCursor: null });
/** A record list's page (P1-4a): the rows and the size of the whole set. */
export const recordPage = <T>(items: T[]): Omit<PersonPage, 'items'> & { items: T[] } => ({
    items,
    nextCursor: null,
    total: items.length,
    totalIsExact: true,
});

// ---- Templates and mail settings (P2-UI-2) --------------------------------------------------
const variable = (path: string) => ({ type: 'variable', attrs: { path } });

export const templates: EmailTemplateView[] = [
    {
        id: IDS.template,
        name: 'Follow-up after a reply',
        kind: 'personal',
        subject: 'Re: {{company.name}} — distribution options',
        body: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Hi ' }, variable('person.firstName'), { type: 'text', text: ',' }],
                },
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Thanks for getting back to me. Attached is the distribution list for ' },
                        variable('company.name'),
                        { type: 'text', text: '.' },
                    ],
                },
            ],
        },
        version: 2,
        updatedBy: member,
        ...created(24 * 4),
    },
    {
        id: IDS.outreachTemplate,
        name: 'Intro — PR distribution offer',
        kind: 'outreach',
        subject: 'Quick one for {{person.firstName}}',
        body: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'I saw ' },
                        variable('company.name'),
                        { type: 'text', text: '’s announcement and thought our distribution could extend its reach.' },
                    ],
                },
            ],
        },
        version: 5,
        updatedBy: member,
        ...created(24 * 9),
    },
];

export const templateVariables: TemplateVariablesView = {
    standard: [
        { path: 'person.firstName', source: 'person', label: 'First name', type: 'text', optional: false },
        { path: 'person.lastName', source: 'person', label: 'Last name', type: 'text', optional: false },
        { path: 'company.name', source: 'company', label: 'Company name', type: 'text', optional: false },
        { path: 'deal.amount', source: 'deal', label: 'Deal amount', type: 'money', optional: false },
        { path: 'sender.signature', source: 'sender', label: 'Signature', type: 'text', optional: true },
    ],
    custom: [{ path: 'person.custom.beat', source: 'person', label: 'Beat', type: 'select', optional: false }],
};

export const mailSettings: MailSettingsView = {
    postalAddress: {
        line1: '123 Main Street',
        line2: 'Suite 400',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        country: 'US',
    },
    defaultSenderName: 'Pinion Partners',
    unsubscribeFooterText: 'You are receiving this email because we thought it would interest you.',
};

// ---- Google client, mailboxes, sync and blocklist (P2-UI-3) ----------------------------------

const REDIRECT_URI = 'https://crm.example.com/api/mail/oauth/callback';
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

/** The admin's view: configured, last checked, the redirect URI not yet proven by a sign-in. */
export const oauthClient: GoogleOAuthClientView = {
    configured: true,
    clientId: '123456789012-abc123def456.apps.googleusercontent.com',
    clientSecretLast4: '1a2b',
    redirectUri: REDIRECT_URI,
    scopes: GMAIL_SCOPES,
    verifiedAt: at(20),
    lastCheck: {
        checkedAt: at(21),
        format: { outcome: 'pass', message: 'The client ID has the shape of a Google web client ID.' },
        credentials: { outcome: 'pass', message: 'Google knows the client and accepts its secret.' },
        redirectUri: { outcome: 'unverified', message: 'Google checks the redirect URI when someone signs in.' },
    },
    liveMailboxes: 2,
    configuredBy: IDS.member,
    updatedAt: at(22),
};

export const oauthClientStatus: GoogleOAuthClientStatusView = {
    configured: true,
    verified: true,
    redirectUri: REDIRECT_URI,
    scopes: GMAIL_SCOPES,
};

/** One personal mailbox working, one shared outreach mailbox Google stopped accepting. */
export const mailboxes: MailboxView[] = [
    {
        id: IDS.mailbox,
        ownerMemberId: IDS.member,
        email: 'kate.morgan@example.com',
        label: null,
        purpose: 'personal',
        status: 'connected',
        grantedScopes: GMAIL_SCOPES,
        lastError: null,
        connectedAt: at(20),
        createdAt: at(20),
        updatedAt: at(20),
    },
    {
        id: IDS.poolMailbox,
        ownerMemberId: IDS.secondMember,
        email: 'outreach@example.com',
        label: 'Q4 outreach',
        purpose: 'pool',
        status: 'reconnect_needed',
        grantedScopes: GMAIL_SCOPES,
        lastError: { code: 'invalid_grant', message: 'Google revoked the app’s access.', at: at(3) },
        connectedAt: at(48),
        createdAt: at(48),
        updatedAt: at(3),
    },
];

export function mailboxSync(mailboxId: string): MailboxSyncView {
    return mailboxId === IDS.mailbox
        ? { mailboxId, status: 'idle', lastSyncedAt: at(0.05), fullSyncCompletedAt: at(19), lastError: null }
        : {
              mailboxId,
              status: 'failed',
              lastSyncedAt: at(4),
              fullSyncCompletedAt: at(47),
              lastError: { code: 'reconnect_needed', message: 'The mailbox needs reconnecting.', at: at(3) },
          };
}

export const blocklist: BlocklistEntryView[] = [
    { id: IDS.blockedDomain, value: '@newsletters.example', scope: 'workspace', createdAt: at(30) },
];

/**
 * The sending pool (P3-2): the one pool mailbox, on warm-up day 11 with a verified domain — not
 * sending while it needs reconnecting.
 */
export const sendingPool: SendingPoolView = {
    settings: {
        dailyCap: 40,
        warmupStartPerDay: 5,
        warmupDays: 21,
        jitterMinSeconds: 60,
        jitterMaxSeconds: 300,
        bouncePauseBps: 500,
        complaintPauseBps: 20,
        rateMinSample: 20,
        rateWindowDays: 7,
    },
    mailboxes: [
        {
            mailboxId: IDS.poolMailbox,
            email: 'outreach@example.com',
            // As the mailbox list has it: Google revoked its access, so it is not sending.
            status: 'reconnect_needed',
            dailyCapOverride: null,
            dailyCap: 40,
            warmupDay: 11,
            warmupLimit: 22,
            allowance: 22,
            used: 7,
            paused: null,
            domain: {
                id: IDS.sendingDomain,
                domain: 'example.com',
                dkimSelector: 'google',
                status: 'pass',
                lastCheck: {
                    spf: { outcome: 'pass', message: 'SPF includes _spf.google.com' },
                    dkim: { outcome: 'pass', message: 'DKIM key found at google._domainkey.example.com' },
                    dmarc: { outcome: 'pass', message: 'DMARC policy none' },
                },
                checkedAt: at(1),
                nextCheckAt: at(-5),
            },
            canSend: false,
        },
    ],
    domains: [],
};
sendingPool.domains = sendingPool.mailboxes.map((m) => m.domain!);

/** The region policy (#141): the defaults, with Canada opened on a stated basis, and that change on record. */
export const regionPolicy: RegionPolicyEntryView[] = [
    { region: 'eu', allowed: false, isDefault: true, lawfulBasis: null, updatedAt: null },
    { region: 'uk', allowed: false, isDefault: true, lawfulBasis: null, updatedAt: null },
    {
        region: 'ca',
        allowed: true,
        isDefault: false,
        lawfulBasis: 'Express consent captured at event sign-up.',
        updatedAt: at(30),
    },
    { region: 'us', allowed: true, isDefault: true, lawfulBasis: null, updatedAt: null },
    { region: 'other', allowed: true, isDefault: true, lawfulBasis: null, updatedAt: null },
    { region: 'unknown', allowed: true, isDefault: true, lawfulBasis: null, updatedAt: null },
];

export const regionPolicyChanges: RegionPolicyChangeView[] = [
    {
        id: '0193a000-0000-7000-8000-00000000c141',
        region: 'ca',
        allowed: true,
        lawfulBasis: 'Express consent captured at event sign-up.',
        changedBy: 'Kate Morgan',
        changedAt: at(30),
    },
];

/** Enrichment (P4-2): every free source on but Gravatar; answers asked a day ago. */
export const enrichmentSettings: EnrichmentSettingsView = {
    reaskAfterDays: 90,
    sources: { website: true, dns: true, gravatar: false, email_domain: true },
    isDefault: false,
    updatedAt: at(5),
};

export const enrichmentHistory = (object: 'person' | 'company', recordId: string): EnrichmentHistoryView => ({
    object,
    recordId,
    lastAskedAt: at(1),
    pending: false,
    answers:
        object === 'company'
            ? [
                  answer(
                      recordId,
                      object,
                      'logo_url',
                      'website',
                      'answered',
                      'https://bigpr.example/logo.png',
                      true,
                      2,
                  ),
                  answer(
                      recordId,
                      object,
                      'linkedin_url',
                      'website',
                      'answered',
                      'https://www.linkedin.com/company/bigpr/',
                      true,
                      2,
                  ),
                  answer(recordId, object, 'x_url', 'website', 'no_answer', null, false, 0),
                  answer(recordId, object, 'mail_provider', 'dns', 'answered', 'google', false, 1),
              ]
            : [
                  answer(recordId, object, 'country', 'email_domain', 'answered', 'GB', true, 1),
                  answer(
                      recordId,
                      object,
                      'avatar_url',
                      'gravatar',
                      'failed',
                      null,
                      false,
                      0,
                      'could not fetch gravatar.com: ETIMEDOUT',
                  ),
              ],
});

function answer(
    recordId: string,
    object: 'person' | 'company',
    field: EnrichmentHistoryView['answers'][number]['field'],
    source: EnrichmentHistoryView['answers'][number]['source'],
    status: EnrichmentHistoryView['answers'][number]['status'],
    value: string | null,
    applied: boolean,
    rank: number,
    note: string | null = null,
): EnrichmentHistoryView['answers'][number] {
    return {
        id: `${recordId}-${field}`,
        object,
        recordId,
        field,
        source,
        status,
        value,
        rank,
        note,
        applied,
        askedAt: at(1),
    };
}

/** How long a verification stands (P3-5): the workspace shortened it from the 90-day default. */
export const verificationSettings: EmailVerificationSettingsView = {
    maxAgeDays: 60,
    isDefault: false,
    updatedAt: at(12),
};

/** The suppression list (P3-1): one of each kind of entry — a permanent one and two an admin may lift. */
export const suppressions: SuppressionView[] = [
    {
        id: IDS.suppressedUnsubscribe,
        address: 'jordan.lee@northwind.example',
        reason: 'unsubscribe',
        source: 'recipient',
        personId: null,
        note: null,
        createdByMemberId: null,
        createdAt: at(2),
        liftable: false,
    },
    {
        id: IDS.suppressedBounce,
        address: 'old.inbox@contoso.example',
        reason: 'hard_bounce',
        source: 'provider',
        personId: null,
        note: null,
        createdByMemberId: null,
        createdAt: at(9),
        liftable: true,
    },
    {
        id: IDS.suppressedManual,
        address: 'press@fabrikam.example',
        reason: 'manual',
        source: 'member',
        personId: null,
        note: 'Asked on a call not to be emailed.',
        createdByMemberId: IDS.member,
        createdAt: at(21),
        liftable: true,
    },
];

/** What a recipient's unsubscribe page reads before they press the button. */
export const unsubscribeStatus: UnsubscribeStatusView = { recipient: 'j•••@northwind.example', unsubscribed: false };
// ---- Mail on a record: a thread and a scheduled send (P2-UI-1) -------------------------------

/** Kate wrote; Dana answered. Kate's own personal mailbox, so the bodies are hers to read. */
export const thread: MailThreadView = {
    id: IDS.thread,
    mailboxIds: [IDS.mailbox],
    subject: 'Distribution options',
    messageCount: 2,
    lastMessageAt: at(2),
    bodiesVisible: true,
    messages: [
        {
            id: IDS.mailMessage,
            mailboxIds: [IDS.mailbox],
            bodiesVisible: true,
            direction: 'outbound',
            from: 'kate.morgan@example.com',
            subject: 'Distribution options',
            snippet: 'Attached is the distribution list for Acme.',
            sentAt: at(26),
            participants: [
                {
                    role: 'from',
                    address: 'kate.morgan@example.com',
                    displayName: 'Kate Morgan',
                    personId: null,
                    memberId: IDS.member,
                },
                {
                    role: 'to',
                    address: 'dana@acme.example',
                    displayName: 'Dana Reyes',
                    personId: IDS.person,
                    memberId: null,
                },
            ],
            hasAttachments: false,
            bodyText: 'Hi Dana, attached is the distribution list for Acme.',
            bodyHtml: '<p>Hi Dana,</p><p>Attached is the distribution list for Acme.</p>',
            bodyTruncated: false,
            rfc822MessageId: 'kate-1@mail.example',
            inReplyTo: null,
        },
        {
            id: IDS.secondMailMessage,
            mailboxIds: [IDS.mailbox],
            bodiesVisible: true,
            direction: 'inbound',
            from: 'dana@acme.example',
            subject: 'Re: Distribution options',
            snippet: 'Thanks — the list looks right.',
            sentAt: at(2),
            participants: [
                {
                    role: 'from',
                    address: 'dana@acme.example',
                    displayName: 'Dana Reyes',
                    personId: IDS.person,
                    memberId: null,
                },
                {
                    role: 'to',
                    address: 'kate.morgan@example.com',
                    displayName: 'Kate Morgan',
                    personId: null,
                    memberId: IDS.member,
                },
            ],
            hasAttachments: false,
            bodyText: 'Thanks — the list looks right. Can we start Monday?',
            bodyHtml: '<p>Thanks — the list looks right. Can we start Monday?</p>',
            bodyTruncated: false,
            rfc822MessageId: 'dana-1@mail.example',
            inReplyTo: 'kate-1@mail.example',
        },
    ],
};

/** A follow-up Kate scheduled for Dana: the person page shows it with Reschedule and Cancel. */
export const scheduledSends: MailOutboundView[] = [
    {
        id: IDS.scheduledSend,
        mailboxId: IDS.mailbox,
        status: 'scheduled',
        subject: 'Checking in on Monday’s start',
        to: ['dana@acme.example'],
        cc: [],
        bcc: [],
        personId: IDS.person,
        dealId: null,
        templateId: null,
        replyToMessageId: null,
        senderMemberId: IDS.member,
        canChange: true,
        canRetry: false,
        rfc822MessageId: `${IDS.scheduledSend}@bylinecrm`,
        mailMessageId: null,
        threadId: null,
        attempts: 0,
        error: null,
        sendAt: new Date(FIXED_NOW + 3 * 24 * 3_600_000).toISOString(),
        senderTimeZone: 'America/Chicago',
        recipientTimeZone: null,
        cancelledAt: null,
        createdAt: at(1),
        sentAt: null,
    },
];

/** One active sequence: an email, a wait, a follow-up in the thread (doc 50 §D). */
export const sequences: SequenceView[] = [
    {
        id: IDS.sequence,
        name: 'Q4 agency outreach',
        status: 'active',
        pipelineId: IDS.pipeline,
        stopOnPipelineExit: true,
        timeZone: 'Asia/Karachi',
        window: { startMinute: 540, endMinute: 1020, days: 31 },
        steps: [
            {
                id: '0b1e0000-0000-4000-8000-000000000a21',
                position: 0,
                kind: 'email',
                templateId: IDS.outreachTemplate,
                replyInThread: false,
                waitDays: null,
                businessDays: false,
                taskTitle: null,
            },
            {
                id: '0b1e0000-0000-4000-8000-000000000a22',
                position: 1,
                kind: 'wait',
                templateId: null,
                replyInThread: false,
                waitDays: 3,
                businessDays: true,
                taskTitle: null,
            },
            {
                id: '0b1e0000-0000-4000-8000-000000000a23',
                position: 2,
                kind: 'email',
                templateId: IDS.outreachTemplate,
                replyInThread: true,
                waitDays: null,
                businessDays: false,
                taskTitle: null,
            },
        ],
        counts: { enrolled: 184, active: 61, held: 0, finished: 97, stopped: 26 },
        createdBy: member,
        createdAt: at(10),
        updatedAt: at(2),
    },
];

/** The person's enrolments: one running, one stopped by a reply (re-enrollable). */
export const enrolments: SequenceEnrolmentView[] = [
    {
        id: IDS.enrolment,
        sequenceId: IDS.sequence,
        personId: IDS.person,
        dealId: null,
        status: 'active',
        stepIndex: 1,
        nextRunAt: at(-1),
        waitingOutboundId: null,
        heldReason: null,
        stopReason: null,
        stopDetail: null,
        enrolledBy: member,
        enrolledByMemberId: IDS.member,
        countryUnknownAtEnrol: false,
        enrolledAt: at(3),
        finishedAt: null,
        stoppedAt: null,
    },
    {
        id: IDS.stoppedEnrolment,
        sequenceId: IDS.sequence,
        personId: IDS.secondPerson,
        dealId: null,
        status: 'stopped',
        stepIndex: 0,
        nextRunAt: null,
        waitingOutboundId: null,
        heldReason: null,
        stopReason: 'reply',
        stopDetail: null,
        enrolledBy: member,
        enrolledByMemberId: IDS.member,
        countryUnknownAtEnrol: false,
        enrolledAt: at(9),
        finishedAt: null,
        stoppedAt: at(5),
    },
];

// ---- The Twenty importer (P4-4, P4-UI-2) ----------------------------------------------------

const twentyObjects = [
    'workspaceMembers',
    'companies',
    'people',
    'opportunities',
    'notes',
    'tasks',
    'leadLookups',
    'leadViews',
    'messageLists',
    'messageListMembers',
    'messageCampaigns',
] as const;
const twentyCounts: Record<
    (typeof twentyObjects)[number],
    [remote: number, created: number, updated: number, skipped: number]
> = {
    workspaceMembers: [33, 31, 0, 2],
    companies: [93167, 93167, 0, 0],
    people: [158869, 158420, 0, 0],
    opportunities: [107357, 107357, 0, 0],
    notes: [4754, 4700, 0, 54],
    tasks: [2, 2, 0, 0],
    leadLookups: [154888, 150928, 0, 3960],
    leadViews: [51, 3, 48, 0],
    messageLists: [0, 0, 0, 0],
    messageListMembers: [0, 0, 0, 0],
    messageCampaigns: [0, 0, 0, 0],
};

/** A finished first import: every object read, with Twenty's counts beside what it did. */
export const twentyImportRun: TwentyImportRunView = {
    id: '0b1e0000-0000-4000-8000-000000000a01',
    status: 'succeeded',
    mode: 'full',
    since: null,
    phase: null,
    report: twentyObjects.map((object) => {
        const [remote, created, updated, skipped] = twentyCounts[object];
        return {
            object,
            remote,
            before: 0,
            read: remote,
            created,
            updated,
            unchanged: 0,
            merged: remote - created - updated - skipped,
            skipped,
            failed: 0,
            after: created + updated,
            missingInSource: null,
            errors:
                object === 'workspaceMembers'
                    ? [
                          {
                              externalId: '0e3de48c-8114-4277-bb82-7b3ad6f7928e',
                              message: 'no member with email dana@example.com',
                          },
                      ]
                    : [],
        };
    }),
    error: null,
    cancelRequested: false,
    startedBy: IDS.member,
    queuedAt: at(26),
    startedAt: at(26),
    finishedAt: at(23),
};

export const twentyImport: TwentyImportOverviewView = {
    settings: {
        configured: true,
        baseUrl: 'https://crm.example.com',
        apiKeyLast4: '7f3a',
        configuredBy: IDS.member,
        updatedAt: at(30),
    },
    latestRun: twentyImportRun,
    linked: twentyImportRun.report.map((r) => ({ object: r.object, count: r.after ?? 0 })),
};

export const twentyImportRuns: TwentyImportRunView[] = [twentyImportRun];
