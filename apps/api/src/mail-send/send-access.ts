import type { Prisma } from '@prisma/client';
import { ApiException } from '../infra/errors/api-errors';

/** The caller as the send rule needs them: their member id and whether they administer the workspace. */
export interface SendAccessCaller {
    memberId?: string | null | undefined;
    capabilities: ReadonlySet<string>;
}

/** The send fields the rule reads. */
export interface SendAccessRow {
    senderMemberId: string;
}

/**
 * Who may see and who may change a send (#133) — one rule for every send route.
 *
 * **Read** (the record's list, the scheduled list, a send by id): anyone who can read the send's
 * record — its person or its deal — so colleagues working a shared record see that someone is
 * already being written to. Its sender always sees it, record or not (a deleted record keeps its
 * sends their sender's). An admin sees every send. "Can read the record" is decided where it always
 * is: the record tables' row-level security, which narrows an own-scoped role to its own records.
 * The relation filter below joins those tables inside the caller's transaction, so it adds nothing
 * of its own.
 *
 * **Change** (reschedule, cancel — and retry when it exists): the sender or an admin. A reader who
 * may see a send but not change it is refused with `403`; a caller who may not see it is told it is
 * not found, never that it exists.
 */
export function readableSends(caller: SendAccessCaller): Prisma.MailOutboundWhereInput {
    if (isAdmin(caller)) return {};
    const readable: Prisma.MailOutboundWhereInput[] = [
        { person: { is: { deletedAt: null } } },
        { deal: { is: { deletedAt: null } } },
    ];
    if (caller.memberId) readable.unshift({ senderMemberId: caller.memberId });
    return { OR: readable };
}

/** Whether the caller may change a send they can see. */
export function canChangeSend(caller: SendAccessCaller, row: SendAccessRow): boolean {
    return isAdmin(caller) || (!!caller.memberId && row.senderMemberId === caller.memberId);
}

/** Refuses a caller who can see a send but may not change it. */
export function assertCanChangeSend(caller: SendAccessCaller, row: SendAccessRow): void {
    if (!canChangeSend(caller, row)) {
        throw new ApiException(403, 'forbidden', 'only the sender or an admin may change this send');
    }
}

function isAdmin(caller: SendAccessCaller): boolean {
    return caller.capabilities.has('workspace:admin');
}
