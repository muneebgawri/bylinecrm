import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForRun } from './wait-for-run.mjs';

/** A fake `gh run view <id> --json status,conclusion` that answers each status in turn. */
function gh(answers) {
    const calls = [];
    let i = 0;
    const capture = (args) => {
        calls.push(args);
        const a = answers[Math.min(i, answers.length - 1)];
        i += 1;
        return JSON.stringify(a);
    };
    return { capture, calls };
}
const noSleep = () => Promise.resolve();

test('#82 keeps polling while the run is queued or in progress, and returns its conclusion when completed', async () => {
    const { capture, calls } = gh([
        { status: 'queued', conclusion: '' },
        { status: 'in_progress', conclusion: '' },
        { status: 'in_progress', conclusion: '' },
        { status: 'completed', conclusion: 'success' },
    ]);
    const result = await waitForRun(capture, '123', { intervalMs: 1, timeoutMs: 60_000, sleep: noSleep });
    assert.equal(result, 'success');
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0], ['run', 'view', '123', '--json', 'status,conclusion']);
});

test('#82 a completed run that failed returns its conclusion; the caller decides', async () => {
    const { capture } = gh([{ status: 'completed', conclusion: 'failure' }]);
    assert.equal(await waitForRun(capture, '9', { intervalMs: 1, timeoutMs: 1_000, sleep: noSleep }), 'failure');
});

test('#82 gives up after the timeout with a message naming the run', async () => {
    const { capture } = gh([{ status: 'in_progress', conclusion: '' }]);
    let now = 0;
    await assert.rejects(
        waitForRun(capture, '77', {
            intervalMs: 10,
            timeoutMs: 50,
            sleep: (ms) => {
                now += ms;
                return Promise.resolve();
            },
            now: () => now,
        }),
        /run 77 did not finish within/,
    );
});
