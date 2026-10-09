import { Navigate, Outlet, type RouteObject } from 'react-router';
import { RequireAuth } from '../auth/RequireAuth';
import { Home as ServiceStatus } from './home';
import { paths } from './paths';
import { WORKSPACE_PARAM } from './params';

/**
 * The route manifest: the one list of pages. Page components are placeholders until the shell
 * mockup is approved (P1-UI-1 is paused on layout by the owner); each is a named export so the
 * approved screens replace them in place without touching the tree below.
 */
export function Placeholder({ name }: { name: string }) {
    return <main data-route={name}>{name}</main>;
}

const protectedRoutes: RouteObject[] = [
    { path: paths.workspaces, element: <Placeholder name="workspaces" /> },
    {
        path: `/w/:${WORKSPACE_PARAM}`,
        element: <Outlet />,
        children: [
            { index: true, element: <RedirectToHome /> },
            { path: 'home', element: <Placeholder name="home" /> },
            { path: 'people', element: <Placeholder name="people" /> },
            { path: 'companies', element: <Placeholder name="companies" /> },
            { path: 'deals', element: <Placeholder name="deals" /> },
            {
                path: 'settings',
                element: <Outlet />,
                children: [
                    { index: true, element: <Navigate to="members" replace /> },
                    { path: 'members', element: <Placeholder name="settings.members" /> },
                    { path: 'roles', element: <Placeholder name="settings.roles" /> },
                    { path: 'api-keys', element: <Placeholder name="settings.api-keys" /> },
                    { path: 'invites', element: <Placeholder name="settings.invites" /> },
                ],
            },
        ],
    },
];

function RedirectToHome() {
    // The index of `/w/:id` is `home`; relative so the id is not re-spelled here.
    return <Navigate to="home" replace />;
}

export const routes: RouteObject[] = [
    { path: paths.root, element: <Navigate to={paths.workspaces} replace /> },
    { path: paths.signIn, element: <Placeholder name="sign-in" /> },
    { path: paths.signUp, element: <Placeholder name="sign-up" /> },
    { path: paths.authCallback, element: <Placeholder name="auth-callback" /> },
    { path: paths.status, element: <ServiceStatus /> },
    { path: paths.forbidden, element: <Placeholder name="403" /> },
    { element: <RequireAuth />, children: protectedRoutes },
    { path: '*', element: <Placeholder name="404" /> },
];
