#!/usr/bin/env node
/**
 * Regenerate a set of visual baselines ON THE CI RUNNER for the current branch and pull them down
 * to commit. This is the only supported way to update a baseline directory; two sets use it:
 *
 *   design system  --job visual-baseline --artifact visual-baselines --dir packages/ui/__snapshots__
 *   route gate     --job routes-baseline --artifact routes-baselines --dir apps/web/e2e/__snapshots__
 *
 * (each package's `*:baseline` script passes its own three). It dispatches the CI workflow with
 * `baseline=true`, which adds the baseline jobs, waits for that run, checks the named job's own
 * conclusion (another job in the run may fail for its own reasons without invalidating these
 * baselines), and downloads the named artifact.
 *
 * The artifact is downloaded into a fresh temporary directory and copied over `__snapshots__/`
 * from there: `gh run download` refuses to overwrite an existing file, and `__snapshots__/` is
 * never empty, so downloading straight into it failed after every successful baseline job.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForRun } from './lib/wait-for-run.mjs';

const WORKFLOW = 'ci.yml';

/** `--job`, `--artifact` and `--dir` (relative to the repository root), all required. */
function arg(name) {
    const at = process.argv.indexOf(`--${name}`);
    const value = at >= 0 ? process.argv[at + 1] : undefined;
    if (!value) throw new Error(`visual:baseline — missing --${name}`);
    return value;
}
const JOB = arg('job');
const ARTIFACT = arg('artifact');
// The directory the gate's Playwright config reads baselines from (its `snapshotPathTemplate`).
const snapshots = resolve(dirname(fileURLToPath(import.meta.url)), '..', arg('dir'));
const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 3000;
/** How often the run's status is read while it runs, and how long it may take before the script gives up. */
const RUN_POLL_INTERVAL_MS = 15_000;
const RUN_TIMEOUT_MS = 45 * 60 * 1000;

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

console.log(`visual:baseline — waiting for run ${id} (gh run view ${id} to follow it)`);
await waitForRun(capture, id, { intervalMs: RUN_POLL_INTERVAL_MS, timeoutMs: RUN_TIMEOUT_MS });

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

    // A gate's first baselines land in a directory that does not exist yet.
    mkdirSync(snapshots, { recursive: true });
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
