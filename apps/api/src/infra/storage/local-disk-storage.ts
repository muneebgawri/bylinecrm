import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FileNotInStorage, type FileStorage, type StorageKey } from './file-storage';

/** A key is a relative path of safe segments; the driver refuses anything that could leave the root. */
const KEY = /^[a-z0-9][a-z0-9/_-]{0,255}$/;

/**
 * Files on the local disk under one root. Writes go to a sibling temporary name and are renamed
 * into place once the stream has ended, so a reader never meets a half-written file and a failed
 * upload leaves nothing behind. Suitable for one server; the interface is what the service
 * depends on, and a shared store replaces this class, not its callers.
 */
export class LocalDiskStorage implements FileStorage {
    private readonly root: string;

    constructor(root: string) {
        this.root = resolve(root);
    }

    async put(key: StorageKey, body: Readable): Promise<{ bytes: number }> {
        const path = this.pathOf(key);
        const partial = `${path}.part`;
        await mkdir(dirname(path), { recursive: true });
        let bytes = 0;
        body.on('data', (chunk: Buffer | string) => {
            bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        });
        try {
            await pipeline(body, createWriteStream(partial, { flags: 'wx' }));
            await rename(partial, path);
        } catch (error) {
            await rm(partial, { force: true });
            throw error;
        }
        return { bytes };
    }

    async get(key: StorageKey): Promise<Readable> {
        const path = this.pathOf(key);
        try {
            await access(path);
        } catch {
            throw new FileNotInStorage(key);
        }
        return createReadStream(path);
    }

    async delete(key: StorageKey): Promise<void> {
        await rm(this.pathOf(key), { force: true });
    }

    private pathOf(key: StorageKey): string {
        if (!KEY.test(key)) throw new Error(`storage key is not valid: ${key}`);
        const path = resolve(join(this.root, key));
        if (!path.startsWith(this.root + sep)) throw new Error(`storage key escapes the root: ${key}`);
        return path;
    }
}
