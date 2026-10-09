import type { Readable } from 'node:stream';

/** The token under which a stored file is found again; opaque to everything but the driver. */
export type StorageKey = string;

/**
 * Where attachment bytes live (PAR-016). The attachment row is the only way to a key, and the
 * row is under the row-level policies, so a driver needs no access control of its own. One
 * interface; `LocalDiskStorage` implements it now, an S3 driver drops in later without a
 * change to the attachments service.
 */
export interface FileStorage {
    /** Streams `body` into storage under a new key and reports how many bytes arrived. */
    put(key: StorageKey, body: Readable): Promise<{ bytes: number }>;
    /** The bytes under `key`, as a stream; rejects with `FileNotInStorage` when there are none. */
    get(key: StorageKey): Promise<Readable>;
    /** Removes the bytes; a key that is already gone is not an error. */
    delete(key: StorageKey): Promise<void>;
}

/** Injection token for the configured driver. */
export const FILE_STORAGE = Symbol('FILE_STORAGE');

export class FileNotInStorage extends Error {
    constructor(key: StorageKey) {
        super(`no file in storage under ${key}`);
        this.name = 'FileNotInStorage';
    }
}
