import { FORGOT_PASSWORD_PAGE, RESET_PASSWORD_PAGE, UNSUBSCRIBE_PAGE_PATH, VERIFY_EMAIL_PAGE } from '@bylinecrm/shared';

/**
 * Every path the app has, once. Navigation, commands, redirects and tests build URLs through
 * these functions and never spell a path inline; a page that is not declared here does not
 * exist (`manifest.tsx` registers exactly this set).
 */
export const paths = {
    root: '/',
    signIn: '/sign-in',
    signUp: '/sign-up',
    authCallback: '/auth/callback',
    /** A mailed verification link's page, and where an unverified person is held (#93). */
    verifyEmail: VERIFY_EMAIL_PAGE,
    forgotPassword: FORGOT_PASSWORD_PAGE,
    /** A mailed reset link's page (#93). */
    resetPassword: RESET_PASSWORD_PAGE,
    workspaces: '/workspaces',
    status: '/status',
    forbidden: '/403',
    /** Every workspace on the server, for platform admins (P0-14). */
    platformWorkspaces: '/platform/workspaces',
    workspace: (workspaceId: string) => `/w/${workspaceId}`,
    home: (workspaceId: string) => `/w/${workspaceId}/home`,
    reports: (workspaceId: string) => `/w/${workspaceId}/reports`,
    people: (workspaceId: string) => `/w/${workspaceId}/people`,
    person: (workspaceId: string, personId: string) => `/w/${workspaceId}/people/${personId}`,
    companies: (workspaceId: string) => `/w/${workspaceId}/companies`,
    company: (workspaceId: string, companyId: string) => `/w/${workspaceId}/companies/${companyId}`,
    deals: (workspaceId: string) => `/w/${workspaceId}/deals`,
    deal: (workspaceId: string, dealId: string) => `/w/${workspaceId}/deals/${dealId}`,
    sequences: (workspaceId: string) => `/w/${workspaceId}/sequences`,
    sequence: (workspaceId: string, sequenceId: string) => `/w/${workspaceId}/sequences/${sequenceId}`,
    templates: (workspaceId: string) => `/w/${workspaceId}/templates`,
    template: (workspaceId: string, templateId: string) => `/w/${workspaceId}/templates/${templateId}`,
    mailboxes: (workspaceId: string) => `/w/${workspaceId}/mailboxes`,
    /** One sending domain's health (#190): an admin's page. */
    sendingDomain: (workspaceId: string, domainId: string) => `/w/${workspaceId}/mailboxes/domains/${domainId}`,
    team: (workspaceId: string) => `/w/${workspaceId}/team`,
    settings: (workspaceId: string) => `/w/${workspaceId}/settings`,
    settingsMembers: (workspaceId: string) => `/w/${workspaceId}/settings/members`,
    settingsRoles: (workspaceId: string) => `/w/${workspaceId}/settings/roles`,
    settingsApiKeys: (workspaceId: string) => `/w/${workspaceId}/settings/api-keys`,
    settingsInvites: (workspaceId: string) => `/w/${workspaceId}/settings/invites`,
    settingsPipelines: (workspaceId: string) => `/w/${workspaceId}/settings/pipelines`,
    settingsPipeline: (workspaceId: string, pipelineId: string) => `/w/${workspaceId}/settings/pipelines/${pipelineId}`,
    settingsCustomFields: (workspaceId: string) => `/w/${workspaceId}/settings/custom-fields`,
    settingsMail: (workspaceId: string) => `/w/${workspaceId}/settings/mail`,
    settingsSignatures: (workspaceId: string) => `/w/${workspaceId}/settings/signatures`,
    settingsGoogle: (workspaceId: string) => `/w/${workspaceId}/settings/google`,
    settingsSuppression: (workspaceId: string) => `/w/${workspaceId}/settings/suppression`,
    settingsRegionPolicy: (workspaceId: string) => `/w/${workspaceId}/settings/region-policy`,
    /** Email verification (P3-5): what each result does at enrolment, and how long a result stands. */
    settingsVerification: (workspaceId: string) => `/w/${workspaceId}/settings/verification`,
    /** Enrichment (P4-2): the free sources on or off, and how long an answer stands. */
    settingsEnrichment: (workspaceId: string) => `/w/${workspaceId}/settings/enrichment`,
    /** Tracking (P3-4): the short-link domain, its CNAME and whether it is verified. */
    settingsTracking: (workspaceId: string) => `/w/${workspaceId}/settings/tracking`,
    /** Ownership (OWN-2): records held by someone other than their company's owner, and the fix. */
    settingsOwnership: (workspaceId: string) => `/w/${workspaceId}/settings/ownership`,
    /** Guardrails (GUARD-1): what the recipient guard refused or let a manager through, for reviewers. */
    settingsGuardrails: (workspaceId: string) => `/w/${workspaceId}/settings/guardrails`,
    /** Slotline (CAL-2): the booking site whose bookings count as meetings, and the hook it posts them to. */
    settingsSlotline: (workspaceId: string) => `/w/${workspaceId}/settings/slotline`,
    /** NewswireOS (INV-1): where invoices on deals are verified, and the hook it reports refunds to. */
    settingsNewswireos: (workspaceId: string) => `/w/${workspaceId}/settings/newswireos`,
    /** SMTP2Go (TRANS-1): pool mailboxes that send through SMTP2Go, with their webhook. */
    settingsSmtp2Go: (workspaceId: string) => `/w/${workspaceId}/settings/smtp2go`,
    /** The Twenty importer (P4-4, P4-UI-2): an admin connects a Twenty workspace and runs the import. */
    settingsImportTwenty: (workspaceId: string) => `/w/${workspaceId}/settings/import-twenty`,
    /** The Bigin importer (BIGIN-1): an admin connects Zoho Bigin and syncs it one way into BylineCRM. */
    settingsImportBigin: (workspaceId: string) => `/w/${workspaceId}/settings/import-bigin`,
    /** A recipient's unsubscribe page (P3-1): public, outside the app — the mail's visible link opens it. */
    unsubscribe: (token: string) => `${UNSUBSCRIBE_PAGE_PATH}/${token}`,
} as const;

/** `?create=1` on a list page opens its "new" dialog (the ⌘K and "+ Create" commands land there). */
export const CREATE_PARAM = 'create';

/** A list page with its "new" dialog open. */
export function withCreate(path: string): string {
    return `${path}?${CREATE_PARAM}=1`;
}

/** The query parameter sign-in uses to return the person where they were. */
export const RETURN_TO = 'returnTo';

/** Sign-in with a safe return address: only a same-origin path is accepted back. */
export function signInPath(returnTo?: string): string {
    if (!returnTo || !isLocalPath(returnTo) || returnTo === paths.signIn) return paths.signIn;
    return `${paths.signIn}?${RETURN_TO}=${encodeURIComponent(returnTo)}`;
}

/** A path that starts with one slash is ours; `//evil.example` or a URL with a scheme is not. */
export function isLocalPath(value: string): boolean {
    return value.startsWith('/') && !value.startsWith('//') && !/^\/[\\]/.test(value);
}

/** Reads the return address from sign-in's query string; the default when absent or unsafe. */
export function returnToFrom(search: string, fallback: string = paths.workspaces): string {
    const value = new URLSearchParams(search).get(RETURN_TO);
    return value && isLocalPath(value) ? value : fallback;
}
