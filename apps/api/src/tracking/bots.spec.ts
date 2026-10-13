import { describe, expect, it } from 'vitest';
import { botReason, isScannerUserAgent } from './bots';

const chrome =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

/**
 * Bot filtering (P3-4, FR-CRMS-8): a hit from a known link scanner, or any hit within 2 s of
 * delivery (security gateways fetch every link as the mail arrives), is kept as a bot hit and
 * counted nowhere. The rule is stated in docs/design-notes/P3-4.md.
 */
describe('FR-CRMS-8 bot filtering', () => {
    it('knows the link scanners and fetch libraries by their user agent, and an empty one', () => {
        for (const ua of [
            'Mozilla/5.0 (compatible; Barracuda Sentinel)',
            'Mozilla/5.0 (Windows NT 10.0) Proofpoint URL Defense',
            'Mimecast Link Scanner',
            'curl/8.4.0',
            'python-requests/2.31',
            'Go-http-client/1.1',
            'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Slackbot-LinkExpanding 1.0',
            '',
        ]) {
            expect(isScannerUserAgent(ua), ua || '(empty)').toBe(true);
        }
    });

    it('lets a person’s browser and a mail client’s image proxy through', () => {
        expect(isScannerUserAgent(chrome)).toBe(false);
        expect(
            isScannerUserAgent(
                'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
            ),
        ).toBe(false);
        expect(isScannerUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe(
            false,
        );
    });

    it('names why a hit is a bot: the agent, or coming within 2 s of delivery; otherwise null', () => {
        const sentAt = new Date('2026-10-12T10:00:00Z');
        const at = (ms: number) => new Date(sentAt.getTime() + ms);
        expect(botReason({ userAgent: 'curl/8.4.0', sentAt, at: at(60_000) })).toBe('scanner_user_agent');
        expect(botReason({ userAgent: chrome, sentAt, at: at(1_500) })).toBe('too_soon_after_delivery');
        expect(botReason({ userAgent: chrome, sentAt, at: at(2_001) })).toBeNull();
        expect(botReason({ userAgent: chrome, sentAt: null, at: at(0) })).toBeNull();
    });
});
