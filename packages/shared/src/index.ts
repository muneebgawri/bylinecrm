/**
 * Types and constants shared by the API, the web app and the repo scripts. One definition; every
 * side imports it.
 */

/** A dependency the API cannot run without. */
export type DependencyState = 'ok' | 'down';

/**
 * Whether the tenant-scoped database client is really the restricted role. `misconfigured` means
 * queries would run with the owner's privileges and row-level security would not apply.
 */
export type RlsState = 'ok' | 'misconfigured';

/** The body of `GET /health`. `status` is `ok` only when every dependency is and RLS is in force. */
export interface HealthStatus {
    status: 'ok' | 'degraded';
    db: DependencyState;
    redis: DependencyState;
    rls: RlsState;
    version: string;
}

/**
 * The Postgres role the application queries tenant data as. It has NOBYPASSRLS and only the table
 * privileges the migrations grant it; `RLS_DATABASE_URL` must log in as this role and nothing else.
 * Named here once: the migrations, the role script and the health probe all read it.
 */
export const APP_DB_ROLE = 'bylinecrm_app';

/**
 * The transaction-local setting that carries the current workspace to the row-level policies.
 * `withWorkspace` sets it; the policies read it through `app_workspace_id()`; unset means no rows.
 */
export const WORKSPACE_SETTING = 'app.workspace_id';

export * from './auth.js';
export * from './capabilities.js';
export * from './errors.js';
export * from './events.js';
export * from './mail.js';
export * from './money.js';
export * from './pipelines.js';
export * from './platform.js';
export * from './records.js';
export * from './suppression.js';
export * from './templates.js';
export * from './views.js';
export * from './timeline.js';
export * from './webhooks.js';
