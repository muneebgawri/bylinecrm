import { paths } from '../src/routes/paths';
import { IDS } from './fixtures';

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
};

export interface RouteState {
    /** A short, stable name: the screenshot file and the report row. */
    name: string;
    /** The URL to open. */
    url: string;
    /** What to do after the page settles to reach the state (open a palette, …). */
    after?: 'palette';
}

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

/** The states that are not a route of their own: the record drawer over a list, and the ⌘K palette. */
const EXTRA_STATES: RouteState[] = [
    { name: 'drawer-person', url: `${paths.deals(IDS.workspace)}?open=person:${IDS.person}` },
    { name: 'drawer-deal', url: `${paths.home(IDS.workspace)}?open=opportunity:${IDS.deal}` },
    { name: 'palette', url: paths.home(IDS.workspace), after: 'palette' },
];

export const STATES: readonly RouteState[] = [...routeStates(), ...EXTRA_STATES];
