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
    workspaces: '/workspaces',
    status: '/status',
    forbidden: '/403',
    workspace: (workspaceId: string) => `/w/${workspaceId}`,
    home: (workspaceId: string) => `/w/${workspaceId}/home`,
    people: (workspaceId: string) => `/w/${workspaceId}/people`,
    companies: (workspaceId: string) => `/w/${workspaceId}/companies`,
    deals: (workspaceId: string) => `/w/${workspaceId}/deals`,
    settings: (workspaceId: string) => `/w/${workspaceId}/settings`,
    settingsMembers: (workspaceId: string) => `/w/${workspaceId}/settings/members`,
    settingsRoles: (workspaceId: string) => `/w/${workspaceId}/settings/roles`,
    settingsApiKeys: (workspaceId: string) => `/w/${workspaceId}/settings/api-keys`,
    settingsInvites: (workspaceId: string) => `/w/${workspaceId}/settings/invites`,
} as const;

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
