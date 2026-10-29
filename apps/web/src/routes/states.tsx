import { Button, EmptyState, LoadingRegion, Skeleton } from '@bylinecrm/ui';
import { useEffect, useState } from 'react';
import { isRouteErrorResponse, Link, useNavigate, useRouteError } from 'react-router';
import { ApiError } from '../api/client';
import { isStaleBuild, mayReloadForNewBuild, reloadForNewBuild } from '../lib/staleBuild';
import { AuthFrame } from './auth/AuthLayout';
import { paths } from './paths';

/** What a route shows while its data loads: the page's shape, no layout shift (FR-CRMS-UI-7). */
export function RouteSkeleton() {
    return (
        <LoadingRegion label="Loading" className="p-7">
            <Skeleton className="mb-2 h-7 w-56" />
            <Skeleton className="mb-6 h-4 w-96" />
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
            </div>
            <Skeleton className="mt-4 h-80" />
        </LoadingRegion>
    );
}

/**
 * What a signed-out page shows while its code loads: the auth card's shape (`AuthLayout`) — logo,
 * title, a form — so the page does not jump when it arrives (FR-CRMS-UI-7, #102).
 */
export function AuthSkeleton() {
    return (
        <AuthFrame>
            <LoadingRegion
                label="Loading"
                className="w-full rounded-xl border border-border bg-surface/90 p-7 shadow-lg backdrop-blur-md sm:p-8"
            >
                <Skeleton className="mb-2 h-6 w-40" />
                <Skeleton className="mb-7 h-4 w-56" />
                <Skeleton className="mb-2 h-4 w-16" />
                <Skeleton className="mb-4 h-9" />
                <Skeleton className="mb-2 h-4 w-20" />
                <Skeleton className="mb-6 h-9" />
                <Skeleton className="h-9" />
            </LoadingRegion>
        </AuthFrame>
    );
}

/**
 * A route's error boundary: says what happened, offers retry and a way back. A 403 and a 404
 * get their own words; everything else is shown with the message the API or the browser gave. Code from
 * before a deploy that is no longer served reloads the page instead (`staleBuild`).
 */
export function RouteError() {
    const error = useRouteError();
    const [reloading] = useState(() => isStaleBuild(error) && mayReloadForNewBuild());
    useEffect(() => {
        if (reloading) reloadForNewBuild();
    }, [reloading]);
    const navigate = useNavigate();
    const status = error instanceof ApiError ? error.status : isRouteErrorResponse(error) ? error.status : undefined;
    const message =
        error instanceof Error ? error.message : isRouteErrorResponse(error) ? error.statusText : String(error);

    if (reloading) return <RouteSkeleton />;

    const title = status === 403 ? 'You cannot open this' : status === 404 ? 'Not found' : 'Something went wrong';
    const body =
        status === 403
            ? 'Your role in this workspace does not include it. An admin can change that.'
            : status === 404
              ? 'There is nothing at this address, or it was removed.'
              : message;

    return (
        <div className="p-7">
            <EmptyState
                tone="error"
                title={title}
                body={body}
                action={
                    <div className="flex gap-2">
                        <Button onClick={() => navigate(0)}>Retry</Button>
                        <Button data-primary-action variant="primary" onClick={() => navigate(-1)}>
                            Go back
                        </Button>
                    </div>
                }
            />
        </div>
    );
}

export function Forbidden() {
    return (
        <main className="grid min-h-dvh place-items-center bg-background p-6 text-text">
            <EmptyState
                tone="error"
                title="You cannot open this"
                body="Your role does not include it. An admin can change that."
                action={
                    <Button data-primary-action asChild variant="primary">
                        <Link to={paths.workspaces}>Your workspaces</Link>
                    </Button>
                }
            />
        </main>
    );
}

export function NotFound() {
    return (
        <main className="grid min-h-dvh place-items-center bg-background p-6 text-text">
            <EmptyState
                title="Not found"
                body="There is nothing at this address."
                action={
                    <Button data-primary-action asChild variant="primary">
                        <Link to={paths.root}>Home</Link>
                    </Button>
                }
            />
        </main>
    );
}
