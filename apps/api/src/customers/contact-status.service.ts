import { ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { ContactStatus } from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import { UniqueConflict } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import { PeopleService } from '../records/people.service';
import type { PersonView } from '../records/responses';
import { SuppressionService } from '../suppression/suppression.service';

/** People re-derived per statement, so a large set never makes one long statement. */
const REFRESH_CHUNK = 1000;

/**
 * Re-derives the contact status (#242), contact attempts and last-contacted time of these people in `tx`, through the
 * migration's `refresh_contact_status()` — the one definition of the rules — `REFRESH_CHUNK` people per statement.
 * Returns how many rows changed.
 */
export async function refreshContactStatus(tx: WorkspaceClient, personIds: readonly string[]): Promise<number> {
    const ids = [...new Set(personIds)];
    let changed = 0;
    for (let i = 0; i < ids.length; i += REFRESH_CHUNK) {
        const chunk = ids.slice(i, i + REFRESH_CHUNK);
        const [row] = await tx.$queryRaw<{ changed: number }[]>`
            SELECT refresh_contact_status(${chunk}::uuid[]) AS changed`;
        changed += Number(row?.changed ?? 0);
    }
    return changed;
}

/**
 * A member setting a person's contact status by hand (#242). Any status but Do Not Contact is stored as the
 * override (`null` clears it, and the derived status shows again). Do Not Contact is the suppression list: setting it
 * suppresses the primary address (as `POST /suppressions` would, and needing what that needs), and lifting the
 * suppression is how it ends.
 */
@Injectable()
export class ContactStatusService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly people: PeopleService,
        private readonly suppression: SuppressionService,
        private readonly events: DomainEvents,
    ) {}

    async set(personId: string, status: ContactStatus | null): Promise<PersonView> {
        const context = this.context.get();
        if (!context) throw new Error('ContactStatusService is used inside a workspace scope');
        const person = await this.people.get(personId); // visibility: a person the caller cannot read is a 404
        if (status === 'do_not_contact') {
            if (!context.capabilities.has('outreach:write')) {
                throw new ForbiddenException('Do Not Contact suppresses the address: that needs outreach:write');
            }
            const address = person.emails.primary;
            if (!address) {
                throw new UnprocessableEntityException('Do Not Contact suppresses the primary address: add one first');
            }
            try {
                await this.suppression.add({ address, note: 'Set as Do Not Contact on the person' });
            } catch (error) {
                if (!(error instanceof UniqueConflict)) throw error; // already suppressed: already Do Not Contact
            }
            await this.rls.withWorkspace((tx) => refreshContactStatus(tx, [personId]));
        } else {
            await this.rls.withWorkspace(async (tx) => {
                if (person.contactStatusOverride !== status) {
                    await tx.person.update({ where: { id: personId }, data: { contactStatusOverride: status } });
                    await this.events.record(tx, {
                        type: 'person.updated',
                        object: 'person',
                        workspaceId: context.workspaceId,
                        actor: actorOf(context),
                        occurredAt: new Date().toISOString(),
                        recordId: personId,
                        diff: { contactStatusOverride: { from: person.contactStatusOverride, to: status } },
                    });
                }
                await refreshContactStatus(tx, [personId]);
            });
        }
        return this.people.get(personId);
    }
}
