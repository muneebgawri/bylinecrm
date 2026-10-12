/**
 * Everything the importer asks a Twenty workspace, behind one interface. The HTTP adapter
 * (`twenty.http.ts`) is the only code that calls Twenty; the tests run it against an in-process
 * fake of Twenty's answers (`test/support/fake-twenty.ts`), so no test ever reaches a real workspace.
 */

export interface TwentyConnection {
    /** The workspace's URL, without `/rest`. */
    baseUrl: string;
    apiKey: string;
}

/** A record as Twenty returns it: its id and timestamps, then the object's own fields, read loosely. */
export interface TwentyRecord {
    id: string;
    createdAt?: string;
    updatedAt?: string;
    [field: string]: unknown;
}

export interface TwentyListOptions {
    /** The previous page's end cursor; null for the first page. */
    cursor: string | null;
    /** `0`: the record's own fields; `1`: its one-to-many relations too (a note's targets). */
    depth: 0 | 1;
    /** Only records Twenty updated at or after this instant (ISO 8601). */
    since?: string | null | undefined;
}

export interface TwentyPage {
    records: TwentyRecord[];
    endCursor: string | null;
    hasNextPage: boolean;
    /** Every record of the object (that the filter admits), not just this page. */
    totalCount: number;
}

export interface TwentyApi {
    list(connection: TwentyConnection, objects: string, options: TwentyListOptions): Promise<TwentyPage>;
    count(connection: TwentyConnection, objects: string): Promise<number>;
}

export const TWENTY_PORT = Symbol('TWENTY_PORT');
