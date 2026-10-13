import { Prisma } from '@prisma/client';

/** Prisma's code for a unique constraint or unique index violation. */
const UNIQUE_VIOLATION_CODE = 'P2002';

/** Prisma's code for a foreign key violation: the write names a row that does not exist. */
const FOREIGN_KEY_VIOLATION_CODE = 'P2003';

/** True when a write collided with a unique constraint or index — the caller turns it into a `409`. */
export function uniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION_CODE;
}

/**
 * True when a write named a row that does not exist — the error filter turns it into a `422` for
 * every route (#119). Note Postgres checks foreign keys without row-level security, so a key into
 * ANOTHER workspace's row passes: a route that takes a reference from the caller must also look it
 * up inside its workspace (see `UnknownReference`). This is the backstop, not the check.
 */
export function foreignKeyViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === FOREIGN_KEY_VIOLATION_CODE;
}

/**
 * Prisma's codes for the database being unreachable or the transaction itself gone: a connection
 * refused, lost or timed out (`P1xxx`), the pool exhausted (`P2024`), the transaction closed under
 * the client (`P2028`), a serialisation conflict (`P2034`).
 */
const UNAVAILABLE_CODES = /^P1\d{3}$|^P2024$|^P2028$|^P2034$/;

/**
 * True when the database, not the write, failed: the connection, the pool, the transaction, the
 * engine. A caller doing many small writes (the Twenty importer, #168) lets this one through to
 * be retried as a whole, and keeps a per-row error — a validation, a refusal — to the row.
 */
export function databaseUnavailable(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) return UNAVAILABLE_CODES.test(error.code);
    return (
        error instanceof Prisma.PrismaClientInitializationError ||
        error instanceof Prisma.PrismaClientRustPanicError ||
        error instanceof Prisma.PrismaClientUnknownRequestError
    );
}
