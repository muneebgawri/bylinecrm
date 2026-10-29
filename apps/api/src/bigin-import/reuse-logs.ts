import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ReuseLogRow } from './reuse-reconciler';

/**
 * The old job's logs: a JSON-lines file, or a directory of them (its `output/bigin_delta_sync.*.jsonl`), read a line
 * at a time. Rows are taken as the old job wrote them (`bigin_id` or `biginRecordId`, `ts`, `email`, `firstName`,
 * `lastName`) or as this command documents (`biginId`); only a `create` or `update` row says who a Contact held at
 * an instant — a transport error, a rejection, a dry run's `would_*` or a deletion says nothing of it.
 */
export async function readReuseLogs(path: string): Promise<ReuseLogRow[]> {
    const files = statSync(path).isDirectory()
        ? readdirSync(path)
              .filter((name) => name.startsWith('bigin_delta_sync.') && name.endsWith('.jsonl'))
              .sort()
              .map((name) => join(path, name))
        : [path];
    const rows: ReuseLogRow[] = [];
    for (const file of files) {
        let at = 0;
        for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
            at += 1;
            if (line.trim() === '') continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                throw new Error(`${file}:${at} is not JSON`);
            }
            const row = logRowOf(parsed);
            if (row) rows.push(row);
        }
    }
    return rows;
}

/** One log line as the reconcile reads it; null for a line that says nothing of who a Contact held. */
export function logRowOf(value: unknown): ReuseLogRow | null {
    if (!value || typeof value !== 'object') return null;
    const o = value as Record<string, unknown>;
    const action = typeof o.action === 'string' ? o.action : null;
    if (action !== null && action !== 'create' && action !== 'update') return null;
    const id = o.biginId ?? o.bigin_id ?? o.biginRecordId;
    const ts = typeof o.ts === 'string' ? o.ts : null;
    if ((typeof id !== 'string' && typeof id !== 'number') || !ts) return null;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    return { biginId: String(id), ts, email: str(o.email), firstName: str(o.firstName), lastName: str(o.lastName) };
}
