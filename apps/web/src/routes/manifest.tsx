import { Navigate, type LazyRouteFunction, type RouteObject } from 'react-router';
import { RequireAuth } from '../auth/RequireAuth';
import { AppShell } from '../shell/AppShell';
import { AuthCallback } from './auth/AuthCallback';
import { SignIn } from './auth/SignIn';
import { SignUp } from './auth/SignUp';
import { Home as ServiceStatus } from './home';
import { paths } from './paths';
import { PIPELINE_PARAM, WORKSPACE_PARAM } from './params';
import { Forbidden, NotFound, RouteError, RouteSkeleton } from './states';
import { ContentPage, type PageId } from './w/pages';
import { Workspaces } from './Workspaces';

/** Settings is its own chunk: admins only, loaded on first visit (FR-CRMS-UI-10). */
/** Record pages are one chunk: the three records share their panels (FR-CRMS-UI-10). */
const records = {
    person: () => import('./w/records/RecordPages').then((m) => ({ Component: m.PersonPage })),
    company: () => import('./w/records/RecordPages').then((m) => ({ Component: m.CompanyPage })),
    deal: () => import('./w/records/RecordPages').then((m) => ({ Component: m.DealPage })),
};

/** The people and companies lists are one chunk: the table, the filter editor's shell, the views. */
const lists = {
    people: () => import('./w/lists/ListPage').then((m) => ({ Component: m.PeopleListPage })),
    companies: () => import('./w/lists/ListPage').then((m) => ({ Component: m.CompaniesListPage })),
};

const settings = {
    layout: () => import('./w/settings/SettingsLayout').then((m) => ({ Component: m.SettingsLayout })),
    members: () => import('./w/settings/Members').then((m) => ({ Component: m.Members })),
    roles: () => import('./w/settings/Roles').then((m) => ({ Component: m.Roles })),
    apiKeys: () => import('./w/settings/ApiKeys').then((m) => ({ Component: m.ApiKeys })),
    invites: () => import('./w/settings/Invites').then((m) => ({ Component: m.Invites })),
    pipelines: () => import('./w/settings/Pipelines').then((m) => ({ Component: m.Pipelines })),
    pipeline: () => import('./w/settings/PipelineDetail').then((m) => ({ Component: m.PipelineDetail })),
    customFields: () => import('./w/settings/CustomFields').then((m) => ({ Component: m.CustomFields })),
};

/** Deals is its own chunk: the board brings dnd-kit and the list brings TanStack (FR-CRMS-UI-10). */
const dealsPage = () => import('./w/deals/DealsPage').then((m) => ({ Component: m.DealsPage }));

/**
 * The route manifest: the one list of pages. A route's `handle.crumb` is its breadcrumb; its
 * `errorElement` is the boundary that says what happened (FR-CRMS-UI-7).
 */
const page = (id: PageId, path: string, crumb: string): RouteObject => ({
    path,
    element: <ContentPage id={id} />,
    handle: { crumb },
    errorElement: <RouteError />,
});

/**
 * A page whose code loads on first visit. Its own `hydrateFallbackElement` is what React Router
 * draws while the code loads on a direct visit — inside the shell's content area — so the shell is
 * on screen from the first frame and only the content waits (P1-UI-10, FR-CRMS-UI-7). Without it the
 * nearest fallback was the workspace route's, which replaced the whole shell.
 */
const lazyPage = (
    path: string,
    lazy: LazyRouteFunction<RouteObject>,
    crumb: string,
    children?: RouteObject[],
): RouteObject => ({
    path,
    lazy,
    handle: { crumb },
    errorElement: <RouteError />,
    hydrateFallbackElement: <RouteSkeleton />,
    ...(children ? { children } : {}),
});

const workspaceRoutes: RouteObject = {
    path: `/w/:${WORKSPACE_PARAM}`,
    // The shell guards itself (`useAuthGate`): it draws its frame at once and holds the content.
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
        { index: true, element: <Navigate to="home" replace /> },
        page('home', 'home', 'Dashboard'),
        page('reports', 'reports', 'Reports'),
        lazyPage('people', lists.people, 'People'),
        lazyPage('people/:personId', records.person, 'Person'),
        lazyPage('companies', lists.companies, 'Companies'),
        lazyPage('companies/:companyId', records.company, 'Company'),
        lazyPage('deals', dealsPage, 'Deals'),
        lazyPage('deals/:dealId', records.deal, 'Deal'),
        page('sequences', 'sequences', 'Sequences'),
        page('templates', 'templates', 'Templates'),
        page('mailboxes', 'mailboxes', 'Mailboxes'),
        page('team', 'team', 'Team'),
        lazyPage('settings', settings.layout, 'Settings', [
            { index: true, element: <Navigate to="members" replace /> },
            lazyPage('members', settings.members, 'Members'),
            lazyPage('roles', settings.roles, 'Roles'),
            lazyPage('api-keys', settings.apiKeys, 'API keys'),
            lazyPage('invites', settings.invites, 'Invites'),
            lazyPage('pipelines', settings.pipelines, 'Pipelines'),
            lazyPage(`pipelines/:${PIPELINE_PARAM}`, settings.pipeline, 'Pipeline'),
            lazyPage('custom-fields', settings.customFields, 'Custom fields'),
        ]),
    ],
};

export const routes: RouteObject[] = [
    { path: paths.root, element: <Navigate to={paths.workspaces} replace /> },
    { path: paths.signIn, element: <SignIn />, errorElement: <RouteError /> },
    { path: paths.signUp, element: <SignUp />, errorElement: <RouteError /> },
    { path: paths.authCallback, element: <AuthCallback />, errorElement: <RouteError /> },
    { path: paths.status, element: <ServiceStatus /> },
    { path: paths.forbidden, element: <Forbidden /> },
    {
        element: <RequireAuth pending={<RouteSkeleton />} />,
        errorElement: <RouteError />,
        children: [{ path: paths.workspaces, element: <Workspaces />, errorElement: <RouteError /> }],
    },
    workspaceRoutes,
    { path: '*', element: <NotFound /> },
];
