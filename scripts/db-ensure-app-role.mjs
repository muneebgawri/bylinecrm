#!/usr/bin/env node
/**
 * Creates or updates the application's restricted Postgres role (doc 49, P0-2).
 *
 * Migrations grant privileges to the role by name, so it must exist before they run, and its
 * password is a secret, so it cannot live in a migration. This script is the one place the role
 * is made: it reads the role name and password from RLS_DATABASE_URL, connects as the owner from
 * DATABASE_URL, and creates or alters the role idempotently. It refuses a URL whose user is not
 * APP_DB_ROLE — the specs assert the same, so a renamed role fails twice rather than silently
 * running row-level security as the owner.
 *
 * Runs in: `pnpm --filter api db:setup` (local), the CI cross-tenant job, and any deploy recipe.
 */
import { APP_DB_ROLE } from '@bylinecrm/shared';
import pg from 'pg';

function required(name) {
    const value = process.env[name];
    if (!value) {
        console.error(`db-ensure-app-role: ${name} is not set`);
        process.exit(1);
    }
    return value;
}

const ownerUrl = required('DATABASE_URL');
const rls = new URL(required('RLS_DATABASE_URL'));
const role = decodeURIComponent(rls.username);
const password = decodeURIComponent(rls.password);
const database = rls.pathname.replace(/^\//, '');

if (role !== APP_DB_ROLE) {
    console.error(`db-ensure-app-role: RLS_DATABASE_URL logs in as "${role}", expected "${APP_DB_ROLE}"`);
    process.exit(1);
}
if (!password) {
    console.error('db-ensure-app-role: RLS_DATABASE_URL carries no password');
    process.exit(1);
}

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
    const ident = client.escapeIdentifier(role);
    const literal = client.escapeLiteral(password);
    // DDL takes no bind parameters; the values are escaped by the driver, never concatenated raw.
    const attributes = `LOGIN PASSWORD ${literal} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`;
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    await client.query(
        exists.rowCount ? `ALTER ROLE ${ident} WITH ${attributes}` : `CREATE ROLE ${ident} WITH ${attributes}`,
    );
    await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(database)} TO ${ident}`);
    console.log(`db-ensure-app-role: ${exists.rowCount ? 'updated' : 'created'} ${role} on ${database}`);
} finally {
    await client.end();
}
