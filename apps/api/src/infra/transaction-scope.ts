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
interface OpenTransaction {
    /** Run once the transaction has committed, in registration order; dropped if it rolls back. */
    readonly afterCommit: (() => void)[];
}

const openTransaction = new AsyncLocalStorage<OpenTransaction>();

/**
 * Runs `fn` marked as inside a tenant transaction, with `hooks` collecting what must run after it
 * commits (`afterCommit`). Used by `withWorkspace` only, which runs the hooks once the commit is
 * through and discards them when the transaction fails.
 */
export function insideTransaction<T>(hooks: (() => void)[], fn: () => T): T {
    return openTransaction.run({ afterCommit: hooks }, fn);
}

/** True inside a tenant transaction's callback (and anything it awaits). */
export function transactionOpen(): boolean {
    return openTransaction.getStore() !== undefined;
}

/** Called outside a tenant transaction by code that may only run inside one. */
export class NoOpenTransactionError extends Error {
    constructor(call: string) {
        super(`${call} must be called inside withWorkspace, in the transaction that makes the change`);
        this.name = 'NoOpenTransactionError';
    }
}

/**
 * Registers `hook` to run after the current tenant transaction commits — never if it rolls back.
 * The outbox uses it to wake the relay the moment an event is durable. A hook must not throw;
 * throws `NoOpenTransactionError` outside a transaction. `call` names the caller, for the message.
 */
export function afterCommit(call: string, hook: () => void): void {
    const open = openTransaction.getStore();
    if (!open) throw new NoOpenTransactionError(call);
    open.afterCommit.push(hook);
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
