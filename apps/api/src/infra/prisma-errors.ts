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
