#!/usr/bin/env node
/**
 * Licence gate (doc 48 §10.1, doc 49 §4). Every dependency in the tree must carry a licence on
 * the allowlist. Anything else — including a package whose licence pnpm cannot determine —
 * fails the build. UNKNOWN is a failure, not a pass: a licence we cannot read is a licence we
 * have not checked.
 *
 * Exceptions live in scripts/licence-exceptions.json as { "<package name>": "<reason>" }. An
 * entry is a reviewed decision with its reason written down, never a way to make the scan
 * quiet; a reviewer reads the reason, not the count.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set([
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    '0BSD',
    'CC0-1.0',
    'Unlicense',
    'Python-2.0',
]);

const here = dirname(fileURLToPath(import.meta.url));
const exceptions = JSON.parse(readFileSync(resolve(here, 'licence-exceptions.json'), 'utf8'));

/**
 * A licence field may be a single SPDX id or an expression such as `(MIT OR Apache-2.0)`.
 * An OR-expression passes when any branch is allowed; an AND-expression only when all are.
 * Anything with parentheses that is not a plain OR/AND of ids is treated as not allowed.
 */
function allowed(licence) {
    const raw = String(licence)
        .trim()
        .replace(/^\(|\)$/g, '');
    if (raw.includes(' OR ')) return raw.split(' OR ').some((l) => ALLOWED.has(l.trim()));
    if (raw.includes(' AND ')) return raw.split(' AND ').every((l) => ALLOWED.has(l.trim()));
    return ALLOWED.has(raw);
}

const json = execFileSync('pnpm', ['licenses', 'list', '--json', '--long'], {
    cwd: resolve(here, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
});
const byLicence = JSON.parse(json);

const failures = [];
for (const [licence, packages] of Object.entries(byLicence)) {
    if (allowed(licence)) continue;
    for (const pkg of packages) {
        if (pkg.name in exceptions) continue;
        failures.push(`${pkg.name}@${(pkg.versions ?? []).join(',')} — ${licence}`);
    }
}

if (failures.length) {
    console.error(`licence-scan: ${failures.length} package(s) outside the allowlist:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log(
    `licence-scan: ok (${Object.keys(byLicence).length} licence kinds, ${Object.keys(exceptions).length} exceptions)`,
);
