/**
 * `items` mapped with at most `concurrency` calls in flight; results in input order. The one
 * bounded fan-out for work against another service (Gmail fetches, DNS lookups): never unbounded,
 * never serial when it need not be.
 */
export async function mapPool<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index]!);
        }
    });
    await Promise.all(workers);
    return results;
}
