import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logRowOf, readReuseLogs } from './reuse-logs';

describe('FR-CRMS-26 BIGIN-1 the old job’s logs, as the reconcile reads them', () => {
    it('takes create and update rows as the old job wrote them, and leaves every other row', () => {
        expect(
            logRowOf({
                action: 'update',
                bigin_id: 5751658000001,
                ts: '2026-09-22T23:43:00Z',
                email: 'a@x.io',
                firstName: 'Ana',
                lastName: 'Lee',
                twenty_id: 't',
            }),
        ).toEqual({
            biginId: '5751658000001',
            ts: '2026-09-22T23:43:00Z',
            email: 'a@x.io',
            firstName: 'Ana',
            lastName: 'Lee',
        });
        expect(logRowOf({ action: 'create', biginRecordId: '9', ts: 't', email: null })).toEqual({
            biginId: '9',
            ts: 't',
            email: null,
            firstName: null,
            lastName: null,
        });
        expect(logRowOf({ biginId: '7', ts: 't', email: 'b@y.io', firstName: 'B', lastName: null })).toMatchObject({
            biginId: '7',
        });
        for (const action of [
            'transport_error',
            'rejected',
            'would_update',
            'soft_delete',
            'deletion_not_found_in_twenty',
        ]) {
            expect(logRowOf({ action, bigin_id: '1', ts: 't' })).toBeNull();
        }
        expect(logRowOf({ action: 'update', ts: 't' })).toBeNull();
        expect(logRowOf({ action: 'update', bigin_id: '1' })).toBeNull();
        expect(logRowOf('not an object')).toBeNull();
    });

    it('reads a file, or the job’s output directory a line at a time, its delta-sync files only', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'reuse-logs-'));
        writeFileSync(
            join(dir, 'bigin_delta_sync.20260922T000000Z.jsonl'),
            '{"action":"update","bigin_id":"1","ts":"t1"}\n\n{"action":"rejected","bigin_id":"1","ts":"t2"}\n',
        );
        writeFileSync(
            join(dir, 'bigin_delta_sync.20260923T000000Z.jsonl'),
            '{"action":"create","bigin_id":"2","ts":"t3"}\n',
        );
        writeFileSync(
            join(dir, 'resolve_relations.20261019T000000Z.jsonl'),
            '{"action":"update","bigin_id":"3","ts":"t4"}\n',
        );
        expect((await readReuseLogs(dir)).map((r) => r.biginId)).toEqual(['1', '2']);
        expect(
            (await readReuseLogs(join(dir, 'bigin_delta_sync.20260923T000000Z.jsonl'))).map((r) => r.biginId),
        ).toEqual(['2']);
        writeFileSync(join(dir, 'bad.jsonl'), 'not json\n');
        await expect(readReuseLogs(join(dir, 'bad.jsonl'))).rejects.toThrow('bad.jsonl:1 is not JSON');
    });
});
