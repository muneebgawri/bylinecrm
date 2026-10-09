#!/usr/bin/env node
/**
 * Regenerate the visual baselines ON THE CI RUNNER for the current branch and pull them down to
 * commit. This is the only supported way to update `__snapshots__/` (see README, "Visual
 * baselines"). It dispatches the CI workflow with `baseline=true`, which adds the
 * `visual-baseline` job, waits for that run, checks that job's own conclusion (another job in
 * the run may fail for its own reasons without invalidating the baselines), and downloads the
 * artifact.
 *
 * The artifact is downloaded into a fresh temporary directory and copied over `__snapshots__/`
 * from there: `gh run download` refuses to overwrite an existing file, and `__snapshots__/` is
 * never empty, so downloading straight into it failed after every successful baseline job.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = 'ci.yml';
const JOB = 'visual-baseline';
const ARTIFACT = 'visual-baselines';
// The directory `gates/playwright.config.ts` reads baselines from (`snapshotPathTemplate`).
const snapshots = resolve(dirname(fileURLToPath(import.meta.url)), '../__snapshots__');
const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 3000;

/** `capture` returns gh's stdout; `run` streams it to the terminal (progress output) and returns nothing. */
const capture = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const run = (args) => {
    execFileSync('gh', args, { stdio: 'inherit' });
};
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

// Runs that already exist before the dispatch are not ours, whatever their status; remember them so
// the poll below cannot latch onto another person's in-progress baseline run on the same branch.
const listDispatchRuns = () =>
    JSON.parse(
        capture([
            'run',
            'list',
            '--workflow',
            WORKFLOW,
            '--branch',
            branch,
            '--event',
            'workflow_dispatch',
            '--limit',
            '20',
            '--json',
            'databaseId',
        ]),
    ).map((r) => String(r.databaseId));
const before = new Set(listDispatchRuns());

console.log(`visual:baseline — dispatching ${WORKFLOW} on ${branch}`);
run(['workflow', 'run', WORKFLOW, '--ref', branch, '-f', 'baseline=true']);

// The dispatch returns before the run is listed; poll briefly for the new run's id.
let id = '';
for (let attempt = 0; attempt < POLL_ATTEMPTS && !id; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    id = listDispatchRuns().find((runId) => !before.has(runId)) ?? '';
}
if (!id) throw new Error('the baseline run did not appear within a minute; check `gh run list`');

console.log(`visual:baseline — watching run ${id}`);
run(['run', 'watch', id]);

const jobs = JSON.parse(capture(['run', 'view', id, '--json', 'jobs'])).jobs;
const job = jobs.find((j) => j.name === JOB);
if (!job || job.conclusion !== 'success') {
    throw new Error(`job ${JOB} finished with "${job?.conclusion ?? 'missing'}" — see \`gh run view ${id}\``);
}

const staging = mkdtempSync(join(tmpdir(), 'bylinecrm-baselines-'));
try {
    console.log(`visual:baseline — downloading ${ARTIFACT}`);
    run(['run', 'download', id, '-n', ARTIFACT, '-D', staging]);

    // The job uploads the flat `__snapshots__/` directory; anything else means the artifact and
    // the test's `snapshotPathTemplate` no longer agree, and copying it would put files where the
    // visual test never reads them.
    const entries = readdirSync(staging);
    const unexpected = entries.filter((name) => !name.endsWith('.png') || !statSync(join(staging, name)).isFile());
    if (unexpected.length) {
        throw new Error(`artifact ${ARTIFACT} holds entries that are not baseline PNGs: ${unexpected.join(', ')}`);
    }
    const downloaded = entries.filter((name) => statSync(join(staging, name)).size > 0);
    if (downloaded.length === 0 || downloaded.length !== entries.length) {
        throw new Error(
            `artifact ${ARTIFACT} is empty or holds empty files (${downloaded.length} of ${entries.length} non-empty)`,
        );
    }

    let added = 0;
    let changed = 0;
    for (const name of downloaded) {
        const from = join(staging, name);
        const to = join(snapshots, name);
        if (!existsSync(to)) added++;
        else if (!readFileSync(from).equals(readFileSync(to))) changed++;
        else continue;
        copyFileSync(from, to);
    }
    console.log(
        `visual:baseline — ${added + changed} files updated (${added} new, ${changed} changed, ${downloaded.length - added - changed} unchanged) in ${snapshots}`,
    );
    console.log('visual:baseline — review `git status` and commit the baselines with the change that caused them.');
} finally {
    rmSync(staging, { recursive: true, force: true });
}
