import type { DependencyState, HealthStatus, RlsState } from '@bylinecrm/shared';
import { Badge, Button, EmptyState, LoadingRegion, Skeleton, ThemeToggle, type BadgeProps } from '@bylinecrm/ui';
import { useEffect, useState } from 'react';
import { fetchHealth } from '../api/health';

type Loadable = { state: 'loading' } | { state: 'ready'; health: HealthStatus } | { state: 'error'; message: string };

/** The one mapping from a reported state to a status colour (Badge's semantics, not a hue). */
function statusOf(state: DependencyState | RlsState | HealthStatus['status']): NonNullable<BadgeProps['status']> {
    switch (state) {
        case 'ok':
            return 'success';
        case 'degraded':
            return 'warning';
        case 'down':
        case 'misconfigured':
            return 'danger';
    }
}

export function Home() {
    const [health, setHealth] = useState<Loadable>({ state: 'loading' });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        fetchHealth()
            .then((h) => !cancelled && setHealth({ state: 'ready', health: h }))
            .catch(
                (e: unknown) =>
                    !cancelled && setHealth({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
            );
        return () => {
            cancelled = true;
        };
    }, [attempt]);

    const retry = () => {
        setHealth({ state: 'loading' });
        setAttempt((n) => n + 1);
    };

    return (
        <div className="min-h-screen bg-background text-text">
            <header className="flex h-12 items-center justify-between border-b border-border px-4">
                <span className="text-sm font-semibold">BylineCRM</span>
                <ThemeToggle />
            </header>
            <main className="p-6">
                <h1 className="text-2xl font-semibold">Service status</h1>
                <section aria-live="polite" className="mt-4 max-w-md text-sm">
                    {health.state === 'loading' && (
                        <LoadingRegion label="Checking the API" className="grid gap-2">
                            <Skeleton className="h-6 w-40" />
                            <Skeleton className="h-6 w-56" />
                            <Skeleton className="h-6 w-48" />
                        </LoadingRegion>
                    )}
                    {health.state === 'error' && (
                        <EmptyState
                            tone="error"
                            title="API unreachable"
                            body={health.message}
                            action={
                                <Button variant="secondary" onClick={retry}>
                                    Retry
                                </Button>
                            }
                        />
                    )}
                    {health.state === 'ready' && (
                        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2">
                            <dt className="text-text-muted">API</dt>
                            <dd>
                                <Badge dot status={statusOf(health.health.status)} data-testid="status">
                                    {health.health.status}
                                </Badge>
                            </dd>
                            <dt className="text-text-muted">Database</dt>
                            <dd>
                                <Badge dot status={statusOf(health.health.db)}>
                                    {health.health.db}
                                </Badge>
                            </dd>
                            <dt className="text-text-muted">Redis</dt>
                            <dd>
                                <Badge dot status={statusOf(health.health.redis)}>
                                    {health.health.redis}
                                </Badge>
                            </dd>
                            <dt className="text-text-muted">Row-level security</dt>
                            <dd>
                                <Badge dot status={statusOf(health.health.rls)}>
                                    {health.health.rls}
                                </Badge>
                            </dd>
                            <dt className="text-text-muted">Version</dt>
                            <dd className="font-mono">{health.health.version}</dd>
                        </dl>
                    )}
                </section>
            </main>
        </div>
    );
}
