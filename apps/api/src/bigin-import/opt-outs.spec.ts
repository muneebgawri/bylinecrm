import { describe, expect, it, vi } from 'vitest';
import { BIGIN_OPT_OUT_NOTE, suppressBiginOptOuts } from './opt-outs';

describe('FR-CRMS-25 BIGIN-1 Bigin opt-outs', () => {
    it('suppresses each opted-out Contact’s addresses once, as their unsubscribe, and leaves the rest alone', async () => {
        const suppress = vi.fn().mockResolvedValue({});
        const n = await suppressBiginOptOuts({ suppress }, 'ws', [
            { id: '1', Email: ' Ana@Acme.com ', Secondary_Email: 'ana.home@x.io', Email_Opt_Out: true },
            { id: '2', Email: 'ana@acme.com', Email_Opt_Out: true },
            { id: '3', Email: 'bob@beta.io', Email_Opt_Out: false },
            { id: '4', Email: 'cy@gamma.io' },
            { id: '5', Email: 'not an address', Email_Opt_Out: true },
        ]);
        expect(n).toBe(2);
        expect(suppress.mock.calls.map(([ws, input]) => [ws, input])).toEqual([
            ['ws', { address: 'ana@acme.com', reason: 'unsubscribe', source: 'recipient', note: BIGIN_OPT_OUT_NOTE }],
            ['ws', { address: 'ana.home@x.io', reason: 'unsubscribe', source: 'recipient', note: BIGIN_OPT_OUT_NOTE }],
        ]);
    });
});
