#!/usr/bin/env node
/**
 * Clean-room gate (doc 48 §3, doc 49 §4). The product is built from behaviour, never from
 * another CRM's source. This scan fails the build if a marker of that source appears anywhere
 * in the tree. It is a tripwire, not proof of cleanliness — the proof is the process.
 *
 * Exempt: parity/ (the behaviour ledger names the reference product by design), this script,
 * and .github/ (the workflow invokes this script by name).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKERS = [
    '@license Enterprise',
    'twentyhq',
    'twenty-server',
    'twenty-front',
    'twenty-orm',
    'TwentyORM',
    '@WorkspaceEntity',
    'WorkspaceEntity',
    'workspace-entity',
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo']);
const EXEMPT = ['parity', '.github', join('scripts', 'identifier-scan.mjs')];

function exempt(rel) {
    return EXEMPT.some((e) => rel === e || rel.startsWith(e + sep));
}

function* files(dir) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) yield* files(full);
        else yield full;
    }
}

const hits = [];
for (const file of files(ROOT)) {
    const rel = relative(ROOT, file);
    if (exempt(rel)) continue;
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        // A binary or unreadable file cannot contain source text we would copy; skip it.
        continue;
    }
    for (const marker of MARKERS) {
        if (text.includes(marker)) hits.push(`${rel}: "${marker}"`);
    }
}

if (hits.length) {
    console.error(`identifier-scan: ${hits.length} hit(s):\n  ${hits.join('\n  ')}`);
    process.exit(1);
}
console.log('identifier-scan: ok');
