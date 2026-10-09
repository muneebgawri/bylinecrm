import type { HealthStatus } from '@bylinecrm/shared';

/** Reads the API's `/health` — the one route outside its `/api` prefix (dev proxy locally, the edge in production). */
export async function fetchHealth(): Promise<HealthStatus> {
    const res = await fetch('/health');
    if (!res.ok) throw new Error(`health: HTTP ${res.status}`);
    return (await res.json()) as HealthStatus;
}
