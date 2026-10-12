import type { RecordObject } from '@bylinecrm/shared';
import type { Page, Route } from '@playwright/test';
import * as data from './fixtures';

/**
 * The API, as the route gate sees it: every `/api/**` request the web app makes is answered here
 * from `fixtures.ts`, inside the browser's network layer (Playwright route interception).
 *
 * Why interception and not the Prism mock (`pnpm mock:api`): Prism answers from the schemas with
 * values it invents, so the same page would read differently from run to run and the screenshots
 * could never match; and what a page shows (a deal three weeks quiet, a field left empty) is
 * chosen here so those states are checked. A fixed, typed answer per route makes every page
 * render real content, identically, on every run. The session is the same
 * fixture: `/api/me` answering 200 is what "signed in" means to the app (RequireAuth), so no
 * cookie or server is involved.
 *
 * A request this table does not answer is NOT allowed to fall through to an error state the gate
 * would then happily check: it is recorded, answered 501, and `routes.spec.ts` fails the route
 * with the method and path, so a page that starts calling a new endpoint has to be given data.
 */
type Json = unknown;
type Handler = (match: RegExpMatchArray, url: URL) => Json;

const W = String.raw`/api/w/[^/]+`;
const ID = String.raw`([^/]+)`;

/** GET routes, most specific first. Writes are answered by `WRITES` below. */
const GETS: [RegExp, Handler][] = [
    [/^\/api\/me$/, () => data.user],
    [/^\/api\/me\/profile$/, () => data.profile],
    [/^\/api\/me\/workspaces$/, () => data.workspaces],
    [/^\/api\/auth\/providers$/, () => data.providers],
    [/^\/api\/auth\/invites\/([^/]+)$/, (m) => invitePreview(m[1])],
    [/^\/api\/platform\/access$/, () => data.platformAccess],
    [/^\/api\/platform\/workspaces$/, () => data.platformWorkspaces],
    [new RegExp(`^${W}/me$`), () => data.membership],
    [new RegExp(`^${W}/members/summary$`), () => data.membersSummary],
    [new RegExp(`^${W}/members$`), () => data.members],
    [new RegExp(`^${W}/roles$`), () => data.roles],
    [new RegExp(`^${W}/api-keys$`), () => data.apiKeys],
    [new RegExp(`^${W}/invites$`), () => data.invites],
    [new RegExp(`^${W}/people/${ID}$`), (m) => byId(data.people, m[1])],
    [new RegExp(`^${W}/people$`), () => data.recordPage(data.people)],
    [new RegExp(`^${W}/companies/${ID}$`), (m) => byId(data.companies, m[1])],
    [new RegExp(`^${W}/companies$`), () => data.recordPage(data.companies)],
    [new RegExp(`^${W}/opportunities/${ID}/history$`), () => data.history],
    [new RegExp(`^${W}/opportunities/${ID}$`), (m) => byId(data.deals, m[1])],
    [new RegExp(`^${W}/opportunities$`), () => data.recordPage(data.deals)],
    [new RegExp(`^${W}/pipelines/${ID}/board$`), () => data.board],
    [new RegExp(`^${W}/pipelines/${ID}/rules$`), () => data.rules],
    [new RegExp(`^${W}/pipelines/${ID}$`), () => data.pipeline],
    [new RegExp(`^${W}/pipelines$`), () => [data.pipeline]],
    [new RegExp(`^${W}/views$`), (_m, url) => data.savedViews(object(url))],
    [
        new RegExp(`^${W}/custom-fields$`),
        (_m, url) =>
            url.searchParams.get('archived') === 'true'
                ? data.archivedCustomFields(object(url))
                : data.customFields(object(url)),
    ],
    [new RegExp(`^${W}/notes$`), () => data.page(data.notes)],
    [new RegExp(`^${W}/tasks$`), () => data.page(data.tasks)],
    [new RegExp(`^${W}/attachments$`), () => data.attachments],
    [new RegExp(`^${W}/timeline$`), () => data.page(data.timeline)],
    [new RegExp(`^${W}/templates/variables$`), () => data.templateVariables],
    [new RegExp(`^${W}/templates/${ID}$`), (m) => byId(data.templates, m[1])],
    [new RegExp(`^${W}/templates$`), () => data.page(data.templates)],
    [new RegExp(`^${W}/settings/mail$`), () => data.mailSettings],
    [new RegExp(`^${W}/mail/oauth-client/status$`), () => data.oauthClientStatus],
    [new RegExp(`^${W}/mail/oauth-client$`), () => data.oauthClient],
    [new RegExp(`^${W}/mail/blocklist$`), () => data.blocklist],
    [new RegExp(`^${W}/suppressions$`), () => data.page(data.suppressions)],
    [new RegExp(`^${W}/outreach/region-policy/changes$`), () => data.regionPolicyChanges],
    [new RegExp(`^${W}/outreach/region-policy$`), () => data.regionPolicy],
    [new RegExp(`^${W}/sequences/${ID}/enrolments$`), () => data.enrolments],
    [new RegExp(`^${W}/sequences/${ID}$`), (m) => byId(data.sequences, m[1])],
    [new RegExp(`^${W}/sequences$`), () => data.sequences],
    [new RegExp(`^${W}/people/${ID}/enrolments$`), (m) => data.enrolments.filter((e) => e.personId === m[1])],
    [new RegExp(`^${W}/sending-pool$`), () => data.sendingPool],
    [new RegExp(`^${W}/import/twenty$`), () => data.twentyImport],
    [new RegExp(`^${W}/import/twenty/runs$`), () => data.twentyImportRuns],
    [new RegExp(`^${W}/import/twenty/runs/[^/]+$`), () => data.twentyImportRun],
    [new RegExp(`^/api/unsubscribe/${ID}/status$`), () => data.unsubscribeStatus],
    [new RegExp(`^${W}/mailboxes/${ID}/sync$`), (m) => data.mailboxSync(m[1] ?? '')],
    [new RegExp(`^${W}/mailboxes$`), () => data.mailboxes],
    [new RegExp(`^${W}/mail/messages$`), (_m, url) => data.page(recordSends(url))],
    [new RegExp(`^${W}/mail/messages/${ID}$`), (m) => byId(data.scheduledSends, m[1])],
    [new RegExp(`^${W}/mail/threads/${ID}$`), (m) => byId([data.thread], m[1])],
    [
        new RegExp(`^${W}/search$`),
        () => ({ people: data.people, companies: data.companies, opportunities: data.deals }),
    ],
];

/** `GET /mail/messages?target=&status=` (#104): the fixture sends about that record, in those statuses. */
function recordSends(url: URL) {
    const [type, id] = (url.searchParams.get('target') ?? '').split(':');
    const statuses = (url.searchParams.get('status') ?? '').split(',');
    return data.scheduledSends.filter(
        (s) =>
            statuses.includes(s.status) &&
            ((type === 'person' && s.personId === id) || (type === 'opportunity' && s.dealId === id)),
    );
}

function byId<T extends { id: string }>(rows: readonly T[], id: string | undefined): T {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`no fixture with id ${id ?? '(none)'}`);
    return row;
}

function invitePreview(token: string | undefined) {
    if (token !== data.INVITE_TOKEN) throw new Error(`no invitation fixture for token ${token ?? '(none)'}`);
    return data.invitePreview;
}

function object(url: URL): RecordObject {
    const value = url.searchParams.get('object');
    if (value !== 'person' && value !== 'company' && value !== 'opportunity') {
        throw new Error(`unexpected ?object=${value ?? '(none)'}`);
    }
    return value;
}

/** A request the gate could not answer: what to show in the failure. */
export interface Unanswered {
    method: string;
    path: string;
    reason: string;
}

/**
 * Installs the answers on `page` and returns the list unanswered requests are pushed onto. The
 * gate only reads pages, so a write is not expected; one that happens anyway is unanswered.
 */
/** Who the session is, when a state needs someone other than the fixture's verified user. */
export interface ApiOptions {
    /** A signed-in person who has not verified their address yet (#93). */
    unverified?: true;
}

export async function installApi(page: Page, options: ApiOptions = {}): Promise<Unanswered[]> {
    const unanswered: Unanswered[] = [];
    await page.route('**/api/**', (route) => answer(route, unanswered));
    // Registered after the table on purpose: Playwright tries the most recently added route first.
    if (options.unverified) {
        await page.route('**/api/me', (route) => route.fulfill({ json: { ...data.user, emailVerified: false } }));
    }
    // The status page reads `/health`; it is served outside `/api` (vite.config.ts proxy).
    await page.route('**/health', (route) =>
        route.fulfill({ json: { status: 'ok', db: 'ok', redis: 'ok', rls: 'ok', version: 'gate' } }),
    );
    return unanswered;
}

async function answer(route: Route, unanswered: Unanswered[]): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'GET') {
        for (const [pattern, handler] of GETS) {
            const match = url.pathname.match(pattern);
            if (!match) continue;
            try {
                await route.fulfill({ json: handler(match, url) });
            } catch (error) {
                unanswered.push({ method, path: url.pathname + url.search, reason: String(error) });
                await route.fulfill({ status: 501, json: { message: 'route gate: fixture error' } });
            }
            return;
        }
    }
    unanswered.push({ method, path: url.pathname + url.search, reason: 'no fixture answers this request' });
    await route.fulfill({ status: 501, json: { message: 'route gate: no fixture for this request' } });
}
