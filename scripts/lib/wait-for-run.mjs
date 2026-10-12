/**
 * Waits for a GitHub Actions run to complete by polling `gh run view <id> --json status,conclusion`
 * (#82). `gh run watch` was used before and exits non-zero while a job is still running in some
 * states, so the script stopped although the run went on to succeed. Polling the run's own status
 * waits for the real end.
 *
 * Returns the run's conclusion (`success`, `failure`, `cancelled`, …) — the caller decides what a
 * conclusion means. Throws when the run has not completed within `timeoutMs`.
 */
export async function waitForRun(capture, id, options) {
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());
    const deadline = now() + options.timeoutMs;
    for (;;) {
        const { status, conclusion } = JSON.parse(capture(['run', 'view', id, '--json', 'status,conclusion']));
        if (status === 'completed') return conclusion;
        if (now() >= deadline) {
            throw new Error(
                `run ${id} did not finish within ${Math.round(options.timeoutMs / 60000)} minutes (last status: ${status})`,
            );
        }
        await sleep(options.intervalMs);
    }
}
