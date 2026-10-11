import { paths } from '../src/routes/paths';
import { IDS, INVITE_TOKEN, LINK_TOKEN } from './fixtures';

/**
 * Every state the route gate visits. The list is built from `paths` — the one declaration of the
 * app's pages, which `manifest.spec.tsx` holds equal to the route manifest in both directions —
 * so a page added to the app is visited without anyone editing this file.
 *
 * A path builder takes the workspace id; a record page's builder also takes the record's id, and
 * `RECORD_IDS` names which fixture to use. A new two-argument builder that is not listed there
 * stops the gate with its name, rather than being visited with a made-up id or skipped.
 */
const RECORD_IDS: Record<string, string> = {
    person: IDS.person,
    company: IDS.company,
    deal: IDS.deal,
    template: IDS.outreachTemplate,
    settingsPipeline: IDS.pipeline,
};

export interface RouteState {
    /** A short, stable name: the screenshot file and the report row. */
    name: string;
    /** The URL to open. */
    url: string;
    /** What to do after the page settles to reach the state (open a palette, …). */
    after?: 'palette';
    /** What this state promises on a phone beyond every page's checks (FR-CRMS-UI-12). */
    phone?: PhoneExpectations;
    /** The session is a signed-in person whose address is not verified yet (#93). */
    unverified?: true;
}

export interface PhoneExpectations {
    /** A record's actions sit in a bar fixed to the bottom of the screen. */
    bottomBar?: true;
    /** The first element matching this selector is above the phone fold (checks.ts, PHONE_FOLD_PX). */
    aboveFold?: string;
}

/**
 * Per-state phone promises, by state name. A record — as a page or as the drawer over a list —
 * keeps its actions in the bottom bar; the deals board shows its first card without scrolling.
 */
const PHONE: Record<string, PhoneExpectations> = {
    person: { bottomBar: true },
    company: { bottomBar: true },
    deal: { bottomBar: true },
    'drawer-person': { bottomBar: true },
    'drawer-deal': { bottomBar: true },
    deals: { aboveFold: '[data-deal-id]' },
};

/**
 * States seen as a signed-in, unverified person (#93). `/verify-email` without a token is where such
 * a person is held; a verified one is sent on to their workspaces, which the gate already visits.
 */
const UNVERIFIED = new Set(['verifyEmail']);

function routeStates(): RouteState[] {
    return Object.entries(paths).map(([name, path]): RouteState => {
        if (typeof path === 'string') return { name, url: path };
        const builder = path as (...ids: string[]) => string;
        if (builder.length === 1) return { name, url: builder(IDS.workspace) };
        if (builder.length === 2) {
            const id = RECORD_IDS[name];
            if (!id) throw new Error(`route gate: paths.${name} takes a record id; add an example id to RECORD_IDS`);
            return { name, url: builder(IDS.workspace, id) };
        }
        throw new Error(`route gate: paths.${name} takes ${builder.length} arguments; teach states.ts how to build it`);
    });
}

/** The states that are not a route of their own: invitation accept, the record drawer, a thread, and the ⌘K palette. */
const EXTRA_STATES: RouteState[] = [
    // Accepting a workspace invitation while signed out (P0-14): `/sign-up` with a token.
    { name: 'accept-invite', url: `${paths.signUp}?invite=${INVITE_TOKEN}` },
    { name: 'drawer-person', url: `${paths.deals(IDS.workspace)}?open=person:${IDS.person}` },
    { name: 'drawer-deal', url: `${paths.home(IDS.workspace)}?open=opportunity:${IDS.deal}` },
    { name: 'palette', url: paths.home(IDS.workspace), after: 'palette' },
    // An email thread opened from the person's timeline: a drawer on a desktop, the whole screen on a phone.
    { name: 'thread', url: `${paths.person(IDS.workspace, IDS.person)}?thread=${IDS.thread}` },
    // The pages a mailed link opens (#93): verify the address, choose a new password.
    { name: 'verify-email-link', url: `${paths.verifyEmail}?token=${LINK_TOKEN}` },
    { name: 'reset-password-link', url: `${paths.resetPassword}?token=${LINK_TOKEN}` },
];

export const STATES: readonly RouteState[] = [...routeStates(), ...EXTRA_STATES].map((state) => {
    const phone = PHONE[state.name];
    const withPhone = phone ? { ...state, phone } : state;
    return UNVERIFIED.has(state.name) ? { ...withPhone, unverified: true as const } : withPhone;
});

// A phone promise for a state that no longer exists is a promise nobody checks: fail loudly.
for (const name of [...Object.keys(PHONE), ...UNVERIFIED]) {
    if (!STATES.some((s) => s.name === name)) throw new Error(`route gate: PHONE names an unknown state "${name}"`);
}
