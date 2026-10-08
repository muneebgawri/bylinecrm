/**
 * Types shared by the API and the web app. One definition; both sides import it.
 */

/** A dependency the API cannot run without. */
export type DependencyState = 'ok' | 'down';

/** The body of `GET /health`. `status` is `ok` only when every dependency is. */
export interface HealthStatus {
    status: 'ok' | 'degraded';
    db: DependencyState;
    redis: DependencyState;
    version: string;
}
