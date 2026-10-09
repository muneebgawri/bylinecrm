import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileNotInStorage } from './file-storage';
import { LocalDiskStorage } from './local-disk-storage';

async function text(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
}

describe('LocalDiskStorage', () => {
    let root: string;
    let storage: LocalDiskStorage;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'bylinecrm-storage-'));
        storage = new LocalDiskStorage(root);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('stores a stream under a key, counts its bytes, and reads it back', async () => {
        const key = 'ws-1/0192f7a0-5a7e-7c2a-9f4e-3f1c2b8d6e01';
        const put = await storage.put(key, Readable.from(['hello, ', 'world']));
        expect(put.bytes).toBe(12);
        expect(await text(await storage.get(key))).toBe('hello, world');
        expect(await readdir(join(root, 'ws-1'))).toEqual(['0192f7a0-5a7e-7c2a-9f4e-3f1c2b8d6e01']);
    });

    it('leaves nothing behind when the stream fails', async () => {
        const key = 'ws-1/broken';
        const failing = new Readable({
            read() {
                this.destroy(new Error('connection reset'));
            },
        });
        await expect(storage.put(key, failing)).rejects.toThrow('connection reset');
        await expect(readdir(join(root, 'ws-1'))).resolves.toEqual([]);
    });

    it('reports a missing key as FileNotInStorage, and deleting it is not an error', async () => {
        await expect(storage.get('ws-1/missing')).rejects.toBeInstanceOf(FileNotInStorage);
        await expect(storage.delete('ws-1/missing')).resolves.toBeUndefined();
    });

    it('refuses a key that is not of the safe shape or would leave the root', async () => {
        for (const key of ['../etc/passwd', '/abs', 'ws 1/x', 'WS/x', '']) {
            await expect(storage.put(key, Readable.from(['x'])), key).rejects.toThrow(/storage key/);
        }
    });
});
