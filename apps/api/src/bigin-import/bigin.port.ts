import type { BiginImportObject } from '@bylinecrm/shared';

/**
 * Everything the importer asks Zoho Bigin, behind one interface. The HTTP adapter (`bigin.http.ts`)
 * is the only code that calls Zoho; the tests run it against an in-process fake of Bigin's answers
 * (`test/support/fake-bigin.ts`), so no test ever reaches a real account.
 */

export interface BiginConnection {
    /** The data centre's OAuth server, e.g. `https://accounts.zoho.com`. */
    accountsUrl: string;
    /** The data centre's API host, e.g. `https://www.zohoapis.com`. */
    apiUrl: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
}

/** A record as Bigin returns it: its id, then the module's own fields, read loosely. */
export interface BiginRecord {
    id: string;
    Modified_Time?: string;
    [field: string]: unknown;
}

export interface BiginListOptions {
    /** Only records Bigin modified after this instant (`If-Modified-Since`); null for every record. */
    since: string | null;
    /** 1-based page within the window. */
    page: number;
    /** v2's token for the next page, when the window could not move (a page token pages past 2,000). */
    pageToken?: string | null | undefined;
    /**
     * Read by v2's page tokens (from its first page when `pageToken` is null): only once v1's 2,000 records of a
     * window that cannot move are read. v2 does not narrow by `If-Modified-Since`, so its pages start at the
     * oldest record and the importer passes over what is older than the window.
     */
    byToken?: boolean | undefined;
}

export interface BiginPage {
    records: BiginRecord[];
    moreRecords: boolean;
    /** v2's token for the page after this one; null when there is none. */
    nextPageToken?: string | null | undefined;
}

/** A record Bigin deleted: `/<Module>/deleted`. */
export interface BiginDeleted {
    id: string;
    deletedTime: string | null;
}

export interface BiginDeletedPage {
    records: BiginDeleted[];
    moreRecords: boolean;
}

export interface BiginApi {
    /** A page of the module, oldest modification first. */
    list(connection: BiginConnection, module: BiginImportObject, options: BiginListOptions): Promise<BiginPage>;
    /** A page of what Bigin deleted of the module since an instant (every deletion it keeps when null). */
    deleted(
        connection: BiginConnection,
        module: BiginImportObject,
        options: BiginListOptions,
    ): Promise<BiginDeletedPage>;
    /** How many records the module holds; null when Bigin will not say. */
    count(connection: BiginConnection, module: BiginImportObject): Promise<number | null>;
    /** The values of the Deals `Stage` picklist (Zoho's fields API), in Bigin's order; null when it has none. */
    dealStages(connection: BiginConnection): Promise<string[] | null>;
    /**
     * Trades a self client's one-time grant code for a refresh token (Zoho's authorization-code grant), so an
     * admin pastes the code Zoho's API console shows instead of running the exchange by hand.
     */
    exchangeGrantCode(
        client: { accountsUrl: string; clientId: string; clientSecret: string },
        code: string,
    ): Promise<string>;
}

export const BIGIN_PORT = Symbol('BIGIN_PORT');
