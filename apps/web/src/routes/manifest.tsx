import { Navigate, type RouteObject } from 'react-router';
import { RequireAuth } from '../auth/RequireAuth';
import { AppShell } from '../shell/AppShell';
import { AuthCallback } from './auth/AuthCallback';
import { SignIn } from './auth/SignIn';
import { SignUp } from './auth/SignUp';
import { Home as ServiceStatus } from './home';
import { paths } from './paths';
import { WORKSPACE_PARAM } from './params';
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

const workspaceRoutes: RouteObject = {
    path: `/w/:${WORKSPACE_PARAM}`,
    element: <AppShell />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <RouteSkeleton />,
    children: [
        { index: true, element: <Navigate to="home" replace /> },
        page('home', 'home', 'Dashboard'),
        page('reports', 'reports', 'Reports'),
        { path: 'people', lazy: lists.people, handle: { crumb: 'People' }, errorElement: <RouteError /> },
        { path: 'people/:personId', lazy: records.person, handle: { crumb: 'Person' }, errorElement: <RouteError /> },
        { path: 'companies', lazy: lists.companies, handle: { crumb: 'Companies' }, errorElement: <RouteError /> },
        {
            path: 'companies/:companyId',
            lazy: records.company,
            handle: { crumb: 'Company' },
            errorElement: <RouteError />,
        },
        { path: 'deals', lazy: dealsPage, handle: { crumb: 'Deals' }, errorElement: <RouteError /> },
        { path: 'deals/:dealId', lazy: records.deal, handle: { crumb: 'Deal' }, errorElement: <RouteError /> },
        page('sequences', 'sequences', 'Sequences'),
        page('templates', 'templates', 'Templates'),
        page('mailboxes', 'mailboxes', 'Mailboxes'),
        page('team', 'team', 'Team'),
        {
            path: 'settings',
            lazy: settings.layout,
            handle: { crumb: 'Settings' },
            errorElement: <RouteError />,
            children: [
                { index: true, element: <Navigate to="members" replace /> },
                { path: 'members', lazy: settings.members, handle: { crumb: 'Members' } },
                { path: 'roles', lazy: settings.roles, handle: { crumb: 'Roles' } },
                { path: 'api-keys', lazy: settings.apiKeys, handle: { crumb: 'API keys' } },
                { path: 'invites', lazy: settings.invites, handle: { crumb: 'Invites' } },
                { path: 'pipelines', lazy: settings.pipelines, handle: { crumb: 'Pipelines' } },
            ],
        },
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
        children: [{ path: paths.workspaces, element: <Workspaces />, errorElement: <RouteError /> }, workspaceRoutes],
    },
    { path: '*', element: <NotFound /> },
];
