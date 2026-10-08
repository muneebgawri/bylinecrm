#!/usr/bin/env node
/**
 * Regenerate the visual baselines ON THE CI RUNNER for the current branch and pull them down to
 * commit. This is the only supported way to update `__snapshots__/` (see README, "Visual
 * baselines"). It dispatches the CI workflow with `baseline=true`, which adds the
 * `visual-baseline` job, then waits for that run and downloads its artifact.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = 'ci.yml';
const ARTIFACT = 'visual-baselines';
const snapshots = resolve(dirname(fileURLToPath(import.meta.url)), '../__snapshots__');

const run = (args, opts = {}) =>
    execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

console.log(`visual:baseline — dispatching ${WORKFLOW} on ${branch}`);
run(['workflow', 'run', WORKFLOW, '--ref', branch, '-f', 'baseline=true']);

// The dispatch returns before the run is listed; poll briefly for the id.
let id = '';
for (let attempt = 0; attempt < 20 && !id; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const json = run([
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
run(['run', 'watch', id, '--exit-status'], { stdio: 'inherit' });

console.log(`visual:baseline — downloading ${ARTIFACT} into ${snapshots}`);
run(['run', 'download', id, '-n', ARTIFACT, '-D', snapshots], { stdio: 'inherit' });
console.log('visual:baseline — done; review `git status` and commit the baselines with the change that caused them.');
