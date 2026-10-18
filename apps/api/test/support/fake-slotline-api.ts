import {
    SlotlineApiError,
    type SlotlineApiPort,
    type SlotlineEventType,
} from '../../src/calendar/slotline/slotline-api.port';
import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';

interface FakeAccount {
    username: string;
    eventTypes: SlotlineEventType[];
}

/**
 * An in-memory Slotline v2 API (#196): no network, ever. An API key resolves to its account; any other key
 * is refused as Slotline refuses it (401). A call never holds a tenant transaction open — every test that
 * reaches Slotline checks the rule here.
 */
export class FakeSlotlineApi implements SlotlineApiPort {
    private readonly accounts = new Map<string, FakeAccount>();
    private down = 0;
    /** Every call: which method, at which site, with which key's last four characters. */
    readonly calls: { method: 'me' | 'eventTypes'; baseUrl: string; keyLast4: string }[] = [];

    addAccount(apiKey: string, account: FakeAccount): void {
        this.accounts.set(apiKey, account);
    }

    /** The next `times` calls get no answer, as when Slotline is down. */
    goDown(times = 1): void {
        this.down = times;
    }

    async me(baseUrl: string, apiKey: string): Promise<{ username: string }> {
        return { username: this.enter('me', baseUrl, apiKey).username };
    }

    async eventTypes(baseUrl: string, apiKey: string): Promise<SlotlineEventType[]> {
        return structuredClone(this.enter('eventTypes', baseUrl, apiKey).eventTypes);
    }

    private enter(method: 'me' | 'eventTypes', baseUrl: string, apiKey: string): FakeAccount {
        assertNoOpenTransaction(`Slotline ${method}`);
        this.calls.push({ method, baseUrl, keyLast4: apiKey.slice(-4) });
        if (this.down > 0) {
            this.down -= 1;
            throw new SlotlineApiError(null, 'Slotline did not answer (network)');
        }
        const account = this.accounts.get(apiKey);
        if (!account) throw new SlotlineApiError(401, 'Slotline answered 401');
        return account;
    }
}
