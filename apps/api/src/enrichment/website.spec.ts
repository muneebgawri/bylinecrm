import { describe, expect, it } from 'vitest';
import { readWebsite } from './website';

const page = `<!doctype html>
<html lang="en"><head>
<title>Acme — Comms for growing teams | Home</title>
<meta property="og:site_name" content="Acme Corporation">
<meta property="og:image" content="/assets/og.png">
<link rel="icon" href="/favicon.ico">
</head><body>
<footer>
  <a href="https://www.linkedin.com/company/acme-corp/">LinkedIn</a>
  <a href="https://twitter.com/intent/tweet?url=https://acme.example">Share</a>
  <a href="https://x.com/acmecorp">X</a>
</footer></body></html>`;

/**
 * What the website source reads from a company's home page (P4-2, FR-CRMS-15): a pure judgement on
 * the HTML and the URL it was finally served from, so the fetch happens elsewhere.
 */
describe('FR-CRMS-15 the website source', () => {
    const findings = readWebsite(page, 'https://www.acme.example/');
    const find = (field: string) => findings.find((f) => f.field === field);

    it('names the company from og:site_name before the title, and the title’s first segment otherwise', () => {
        expect(find('name')).toMatchObject({ status: 'answered', value: 'Acme Corporation', rank: 3 });
        expect(
            readWebsite('<title>Acme — Comms | Home</title>', 'https://acme.example/').find((f) => f.field === 'name'),
        ).toMatchObject({
            status: 'answered',
            value: 'Acme',
            rank: 1,
        });
    });

    it('takes the logo from og:image, resolved against the page, and falls back to the icon', () => {
        expect(find('logo_url')).toMatchObject({ value: 'https://www.acme.example/assets/og.png', rank: 2 });
        const iconOnly = readWebsite('<link rel="icon" href="/favicon.ico">', 'https://acme.example/');
        expect(iconOnly.find((f) => f.field === 'logo_url')).toMatchObject({
            value: 'https://acme.example/favicon.ico',
            rank: 1,
        });
    });

    it('reads the company’s LinkedIn and X profiles, never a share link', () => {
        expect(find('linkedin_url')).toMatchObject({ value: 'https://www.linkedin.com/company/acme-corp/' });
        expect(find('x_url')).toMatchObject({ value: 'https://x.com/acmecorp' });
    });

    it('reads the domain the site is served from, without www.', () => {
        expect(find('domain')).toMatchObject({ status: 'answered', value: 'acme.example' });
    });

    it('records what the page does not say as no answer — never an empty string', () => {
        const bare = readWebsite('<html><body>Hello</body></html>', 'https://acme.example/');
        for (const field of ['name', 'logo_url', 'linkedin_url', 'x_url']) {
            expect(
                bare.find((f) => f.field === field),
                field,
            ).toMatchObject({ status: 'no_answer' });
            expect(bare.find((f) => f.field === field)).not.toHaveProperty('value');
        }
    });
});
