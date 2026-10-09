#!/usr/bin/env node
/**
 * Regenerate the visual baselines ON THE CI RUNNER for the current branch and pull them down to
 * commit. This is the only supported way to update `__snapshots__/` (see README, "Visual
 * baselines"). It dispatches the CI workflow with `baseline=true`, which adds the
 * `visual-baseline` job, waits for that run, checks that job's own conclusion (another job in
 * the run may fail for its own reasons without invalidating the baselines), and downloads the
 * artifact.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = 'ci.yml';
const JOB = 'visual-baseline';
const ARTIFACT = 'visual-baselines';
const snapshots = resolve(dirname(fileURLToPath(import.meta.url)), '../__snapshots__');

/** `capture` returns gh's stdout; `run` streams it to the terminal (progress output) and returns nothing. */
const capture = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const run = (args) => {
    execFileSync('gh', args, { stdio: 'inherit' });
};
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

console.log(`visual:baseline — dispatching ${WORKFLOW} on ${branch}`);
run(['workflow', 'run', WORKFLOW, '--ref', branch, '-f', 'baseline=true']);

// The dispatch returns before the run is listed; poll briefly for the id.
let id = '';
for (let attempt = 0; attempt < 20 && !id; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const json = capture([
        'run',
        'list',
        '--workflow',
        WORKFLOW,
        '--branch',
        branch,
        '--event',
        'workflow_dispatch',
        '--limit',
        '1',
        '--json',
        'databaseId,status',
    ]);
    const [latest] = JSON.parse(json);
    if (latest && latest.status !== 'completed') id = String(latest.databaseId);
}
if (!id) throw new Error('the baseline run did not appear within a minute; check `gh run list`');

console.log(`visual:baseline — watching run ${id}`);
run(['run', 'watch', id]);

const jobs = JSON.parse(capture(['run', 'view', id, '--json', 'jobs'])).jobs;
const job = jobs.find((j) => j.name === JOB);
if (!job || job.conclusion !== 'success') {
    throw new Error(`job ${JOB} finished with "${job?.conclusion ?? 'missing'}" — see \`gh run view ${id}\``);
}

console.log(`visual:baseline — downloading ${ARTIFACT} into ${snapshots}`);
run(['run', 'download', id, '-n', ARTIFACT, '-D', snapshots]);
console.log('visual:baseline — done; review `git status` and commit the baselines with the change that caused them.');
