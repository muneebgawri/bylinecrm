import type { HealthStatus } from '@bylinecrm/shared';
import { useEffect, useState } from 'react';
import { fetchHealth } from '../api/health';

type Loadable = { state: 'loading' } | { state: 'ready'; health: HealthStatus } | { state: 'error'; message: string };

export function Home() {
    const [health, setHealth] = useState<Loadable>({ state: 'loading' });

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
    }, []);

    return (
        <main className="min-h-screen p-8 font-sans">
            <h1 className="text-2xl font-semibold">BylineCRM</h1>
            <section aria-live="polite" className="mt-4 text-sm">
                {health.state === 'loading' && <p>Checking the API…</p>}
                {health.state === 'error' && <p role="alert">API unreachable: {health.message}</p>}
                {health.state === 'ready' && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4">
                        <dt>API</dt>
                        <dd data-testid="status">{health.health.status}</dd>
                        <dt>Database</dt>
                        <dd>{health.health.db}</dd>
                        <dt>Redis</dt>
                        <dd>{health.health.redis}</dd>
                        <dt>Version</dt>
                        <dd>{health.health.version}</dd>
                    </dl>
                )}
            </section>
        </main>
    );
}
