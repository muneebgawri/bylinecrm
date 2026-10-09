import { Prisma } from '@prisma/client';

/** Prisma's code for a unique constraint or unique index violation. */
const UNIQUE_VIOLATION_CODE = 'P2002';

/** True when a write collided with a unique constraint or index — the caller turns it into a `409`. */
export function uniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION_CODE;
}
