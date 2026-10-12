#!/usr/bin/env node
/**
 * FR traceability (doc 49 §7, #69): every requirement a phase builds is named by a test.
 *
 * Reads docs/fr-scope.txt (the one list of requirement ids, by phase, with each phase's state) and
 * every test title in the repo — the first argument of `describe(`, `it(` and `test(` in *.spec.ts,
 * *.spec.tsx and *.test.mjs — and prints coverage per phase. A requirement of a `complete` phase that
 * no title names fails the run. There is no separate register to drift: the titles are the record.
 *
 * `traceability(scope, titles)` is exported for the test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = 'docs/fr-scope.txt';
/** Where tests live; node_modules and build output are never read. */
const ROOTS = ['apps/api/src', 'apps/api/test', 'apps/web/src', 'apps/web/e2e', 'packages/ui/src'];
const TEST_FILE = /\.(spec\.tsx?|test\.mjs)$/;
const SKIP_DIR = new Set(['node_modules', 'dist', '__snapshots__', 'generated']);
const FR_ID = /FR-CRMS(?:-UI)?-\d+/g;
/** A test title: the string that opens a describe/it/test call. */
const TITLE = /\b(?:describe|it|test)(?:\.(?:only|skip|each|todo))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const STATES = new Set(['complete', 'in progress', 'not started']);

/** The scope file as phases: `{ name, state, ids }`, plus the deferred ids. */
export function parseScope(text) {
    const phases = [];
    const deferred = [];
    let current = null;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const header = /^\[(.+?)(?::\s*(.+?))?\]$/.exec(line);
        if (header) {
            const name = header[1].trim();
            if (name === 'deferred') {
                current = { name, state: 'deferred', ids: deferred };
                continue;
            }
            const state = (header[2] ?? '').trim();
            if (!STATES.has(state))
                throw new Error(`${SCOPE}: phase "${name}" needs a state: complete | in progress | not started`);
            current = { name, state, ids: [] };
            phases.push(current);
            continue;
        }
        if (!current) throw new Error(`${SCOPE}: "${line}" is outside any [phase] section`);
        if (!/^FR-CRMS(?:-UI)?-\d+$/.test(line)) throw new Error(`${SCOPE}: "${line}" is not a requirement id`);
        current.ids.push(line);
    }
    const seen = new Set();
    for (const id of [...phases.flatMap((p) => p.ids), ...deferred]) {
        if (seen.has(id)) throw new Error(`${SCOPE}: ${id} is listed twice`);
        seen.add(id);
    }
    return { phases, deferred };
}

/** Every requirement id named in any test title. */
export function namedIds(files) {
    const named = new Set();
    for (const { text } of files) {
        for (const match of text.matchAll(TITLE)) {
            for (const id of match[2].matchAll(FR_ID)) named.add(id[0]);
        }
    }
    return named;
}

/**
 * Coverage per phase and the gaps that fail: ids of a `complete` phase no title names.
 * Returns `{ lines, failures }`; `lines` is the report, `failures` the ids that fail the run.
 */
export function traceability(scope, files) {
    const named = namedIds(files);
    const lines = [];
    const failures = [];
    for (const phase of scope.phases) {
        const missing = phase.ids.filter((id) => !named.has(id));
        lines.push(`${phase.name} (${phase.state}): ${phase.ids.length - missing.length}/${phase.ids.length} named`);
        for (const id of missing) {
            lines.push(`  ${phase.state === 'complete' ? 'MISSING' : 'not yet'}: ${id}`);
            if (phase.state === 'complete') failures.push(id);
        }
    }
    if (scope.deferred.length) lines.push(`deferred (not checked): ${scope.deferred.join(', ')}`);
    const unknown = [...named].filter(
        (id) => !scope.phases.some((p) => p.ids.includes(id)) && !scope.deferred.includes(id),
    );
    if (unknown.length) {
        lines.push(`named in a title but not in ${SCOPE}: ${unknown.join(', ')}`);
        failures.push(...unknown);
    }
    return { lines, failures };
}

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIR.has(entry)) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) yield* walk(path);
        else if (TEST_FILE.test(entry)) yield path;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const scope = parseScope(readFileSync(SCOPE, 'utf8'));
    const files = ROOTS.flatMap((root) => [...walk(root)].map((path) => ({ path, text: readFileSync(path, 'utf8') })));
    const { lines, failures } = traceability(scope, files);
    console.log(`fr-traceability: ${files.length} test files read`);
    for (const line of lines) console.log(line);
    if (failures.length) {
        console.error(`fr-traceability: ${failures.length} requirement(s) of a complete phase named by no test`);
        process.exit(1);
    }
}
