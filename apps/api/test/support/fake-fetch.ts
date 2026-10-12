import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';
import { FetchFailed, type EnrichmentFetch, type FetchedPage } from '../../src/enrichment/fetch.port';

/**
 * In-memory web for the tests: pages by URL (as asked, exactly), each with the status, type and
 * final URL a real fetch would report, and the images Gravatar-style `exists` checks find. A URL
 * nothing was set for fails as an unreachable host does. Like the real adapter, it refuses to be
 * asked inside a database transaction.
 */
export class FakeFetch implements EnrichmentFetch {
    private readonly pages = new Map<string, FetchedPage>();
    private readonly present = new Set<string>();
    private readonly failing = new Set<string>();
    readonly gets: string[] = [];
    readonly checks: string[] = [];

    page(url: string, html: string, options: Partial<Omit<FetchedPage, 'text'>> = {}): void {
        this.pages.set(url, {
            status: options.status ?? 200,
            contentType: options.contentType ?? 'text/html; charset=utf-8',
            finalUrl: options.finalUrl ?? url,
            text: html,
        });
        this.failing.delete(url);
    }

    /** Every fetch of the URL fails (a timeout, a refused connection) until a page is set again. */
    fail(url: string): void {
        this.failing.add(url);
    }

    exists(url: string, present = true): void {
        if (present) this.present.add(url);
        else this.present.delete(url);
    }

    get(url: string): Promise<FetchedPage> {
        assertNoOpenTransaction('FakeFetch.get');
        this.gets.push(url);
        const page = this.pages.get(url);
        if (!page || this.failing.has(url)) return Promise.reject(new FetchFailed(url, 'ECONNREFUSED'));
        return Promise.resolve({ ...page });
    }

    check(url: string): Promise<boolean> {
        assertNoOpenTransaction('FakeFetch.check');
        this.checks.push(url);
        return Promise.resolve(this.present.has(url));
    }
}
