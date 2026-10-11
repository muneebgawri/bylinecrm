import { MAILBOX_CONNECT_RESULTS } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { CONNECT_RESULT_MESSAGES, connectResultFrom } from './connectResults';

describe('FR-CRMS-1: every way a Google connect can end has its own message', () => {
    it('names a title and what to do for every result the API can report', () => {
        for (const result of MAILBOX_CONNECT_RESULTS) {
            const message = CONNECT_RESULT_MESSAGES[result];
            expect(message.title, result).toBeTruthy();
            expect(message.body, result).toBeTruthy();
        }
        const titles = MAILBOX_CONNECT_RESULTS.map((r) => CONNECT_RESULT_MESSAGES[r].title);
        expect(new Set(titles).size).toBe(titles.length);
    });

    it('only a successful connect is a success; every refusal is a danger', () => {
        for (const result of MAILBOX_CONNECT_RESULTS) {
            expect(CONNECT_RESULT_MESSAGES[result].tone, result).toBe(result === 'connected' ? 'success' : 'danger');
        }
    });

    it('reads a known result from the query string and ignores anything else', () => {
        expect(connectResultFrom('scope_too_broad')).toBe('scope_too_broad');
        expect(connectResultFrom('nonsense')).toBeNull();
        expect(connectResultFrom(null)).toBeNull();
    });
});
