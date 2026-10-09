#!/usr/bin/env node
/**
 * Serves the frozen contract (doc 49 §1) with Prism so a UI package can be built against the
 * API's shape before — or without — the real API. Reads `MOCK_API_PORT` from the environment
 * (`pnpm mock:api` loads `.env`); the document is `apps/api/openapi.json`, nothing else.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.MOCK_API_PORT;
if (!port) {
    console.error('mock-api: MOCK_API_PORT is not set (copy .env.example to .env)');
    process.exit(1);
}
const prism = resolve(root, 'node_modules', '.bin', 'prism');
const child = spawn(
    prism,
    ['mock', resolve(root, 'apps', 'api', 'openapi.json'), '--host', '127.0.0.1', '--port', port],
    {
        stdio: 'inherit',
    },
);
child.on('exit', (code) => process.exit(code ?? 1));
