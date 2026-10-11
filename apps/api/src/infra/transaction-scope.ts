import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Whether the current async call chain is inside a tenant transaction (#86).
 *
 * A transaction pins one pooled connection until it ends. One that waits on Gmail, Google's token
 * endpoint or a webhook receiver holds that connection for a network round trip — under load,
 * long enough to starve everything else waiting for the pool. So a network call never happens
 * inside one: read what you need, let the transaction end, call out, then write in a new one.
 *
 * `withWorkspace` marks the chain it runs its callback in; the network boundaries (the webhook
 * sender, and the Gmail and Google fakes every test runs against) call `assertNoOpenTransaction`
 * before they go out, so a regression fails loudly at the call that broke the rule.
 */
const openTransaction = new AsyncLocalStorage<true>();

/** Runs `fn` marked as inside a tenant transaction. Used by `withWorkspace` only. */
export function insideTransaction<T>(fn: () => T): T {
    return openTransaction.run(true, fn);
}

/** True inside a tenant transaction's callback (and anything it awaits). */
export function transactionOpen(): boolean {
    return openTransaction.getStore() === true;
}

/** A network call was made while a tenant transaction held its connection. */
export class TransactionAcrossNetworkError extends Error {
    constructor(call: string) {
        super(`${call} was called inside a tenant transaction; make network calls outside withWorkspace`);
        this.name = 'TransactionAcrossNetworkError';
    }
}

/** Throws when called inside a tenant transaction. `call` names the network call, for the message. */
export function assertNoOpenTransaction(call: string): void {
    if (transactionOpen()) throw new TransactionAcrossNetworkError(call);
}
