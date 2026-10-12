import type { EmailVerification } from '@bylinecrm/shared';

/** Injection token for the verifier in use; tests may override it with a fake. */
export const VERIFIER = Symbol('VERIFIER');

/**
 * What answers whether an address is deliverable (P3-5, FR-CRMS-14). The free layer is the one
 * implementation here; a vendor adapter (P4-1) implements the same and names itself in `source`.
 * `verify` reaches the network, so it is never called inside a database transaction (P2-2a): the
 * service reads what is stored, asks the verifier for what is missing or stale, then writes.
 */
export interface Verifier {
    readonly source: string;
    verify(address: string): Promise<EmailVerification>;
}
