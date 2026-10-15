import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { DomainEvents } from '../events/domain-events.service';
import { personsByAddress } from '../mail-sync/matching';
import { PeopleService } from '../records/people.service';
import { CALENDAR_LEAD_SOURCE } from './calendar.constants';
import { MeetingStore } from './meeting-store';
import { memberInScope } from './meetings.service';
import type { LeadSuggestionAccepted, LeadSuggestionView } from './responses';
import { SLOTLINE_LEAD_SOURCE } from './slotline/slotline.constants';

/** How many of a suggestion's meetings it lists. */
const SUGGESTION_MEETINGS_SHOWN = 5;

/** The rows of one suggestion still waiting for the member's word. */
const pending = (memberId: string, address?: string) => ({
    leadSuggestedForMemberId: memberId,
    leadDismissedAt: null,
    leadCreatedForMemberId: null,
    personId: null,
    ...(address ? { address } : {}),
    event: { status: { not: 'cancelled' as const } },
});

/**
 * Suggested leads (CAL-3): meeting attendees who may or may not be leads — the member was invited by someone
 * outside, or they are at a free-mail domain — and so were not made people by sync. A meeting counts towards a
 * member's KPIs only once a person outside it is theirs, so a suggestion is the member's choice:
 *
 * - **Add as lead** makes the person (source: the meeting's, owned by the member), or gives them an existing
 *   person nobody owns; their meetings then count. A person owned by someone else stays theirs (`409`).
 * - **Not a lead** dismisses the address for that member: it is not suggested to them again, and nothing else
 *   changes — the address is not blocklisted (that would purge its mail).
 *
 * Grouped by address: one suggestion however many meetings the person was on. An admin acts for any member;
 * anyone else for themselves (`memberInScope`).
 */
@Injectable()
export class LeadSuggestionsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly store: MeetingStore,
        private readonly people: PeopleService,
        private readonly events: DomainEvents,
    ) {}

    list(requested: string | undefined): Promise<LeadSuggestionView[]> {
        const context = this.current();
        const memberId = memberInScope(context, requested);
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.calendarEventParticipant.findMany({
                where: memberId ? pending(memberId) : { ...pending(''), leadSuggestedForMemberId: { not: null } },
                select: {
                    address: true,
                    displayName: true,
                    leadSuggestedForMemberId: true,
                    createdAt: true,
                    event: { select: { id: true, title: true, startsAt: true } },
                },
                orderBy: [{ event: { startsAt: 'desc' } }, { id: 'asc' }],
            });
            const grouped = new Map<string, LeadSuggestionView>();
            for (const row of rows) {
                const key = `${row.leadSuggestedForMemberId}|${row.address}`;
                const seen = grouped.get(key);
                if (!seen) {
                    grouped.set(key, {
                        memberId: row.leadSuggestedForMemberId!,
                        address: row.address,
                        displayName: row.displayName,
                        meetings: [row.event],
                        suggestedAt: row.createdAt,
                    });
                    continue;
                }
                if (!seen.displayName && row.displayName) seen.displayName = row.displayName;
                if (seen.meetings.length < SUGGESTION_MEETINGS_SHOWN) seen.meetings.push(row.event);
                if (row.createdAt < seen.suggestedAt) seen.suggestedAt = row.createdAt;
            }
            return [...grouped.values()];
        });
    }

    async accept(input: { address: string; memberId?: string | undefined }): Promise<LeadSuggestionAccepted> {
        const context = this.current();
        const memberId = this.actingFor(context, input.memberId);
        const address = input.address.trim().toLowerCase();
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.calendarEventParticipant.findMany({
                where: pending(memberId, address),
                select: { id: true, displayName: true, event: { select: { bookedVia: true } } },
                orderBy: { createdAt: 'desc' },
            });
            if (rows.length === 0) throw new ApiException(404, 'not_found', 'no such suggestion');
            const recorded: DomainEvent[] = [];
            const personId = await this.personFor(tx, context, memberId, address, rows, recorded);
            await tx.calendarEventParticipant.updateMany({
                where: { id: { in: rows.map((r) => r.id) } },
                data: { personId, leadCreatedForMemberId: memberId },
            });
            await this.events.recordAll(tx, recorded);
            return { personId };
        });
    }

    async dismiss(input: { address: string; memberId?: string | undefined }): Promise<void> {
        const context = this.current();
        const memberId = this.actingFor(context, input.memberId);
        const address = input.address.trim().toLowerCase();
        await this.rls.withWorkspace(async (tx) => {
            const result = await tx.calendarEventParticipant.updateMany({
                where: { leadSuggestedForMemberId: memberId, address, leadDismissedAt: null, personId: null },
                data: { leadDismissedAt: new Date() },
            });
            if (result.count === 0) throw new ApiException(404, 'not_found', 'no such suggestion');
        });
    }

    /**
     * The person the suggestion becomes: an existing live person with the address — given to the member when
     * nobody owns them, refused when someone else does — or a new one the member owns.
     */
    private async personFor(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        memberId: string,
        address: string,
        rows: { displayName: string; event: { bookedVia: string } }[],
        recorded: DomainEvent[],
    ): Promise<string> {
        const existing = (await personsByAddress(tx, [address])).get(address);
        if (existing) {
            const person = await tx.person.findUniqueOrThrow({ where: { id: existing }, select: { ownerId: true } });
            if (person.ownerId && person.ownerId !== memberId) {
                throw new ApiException(
                    409,
                    'conflict',
                    'this person is already another member’s; an admin may reassign them',
                );
            }
            if (!person.ownerId) {
                const updated = await this.people.updateIn(tx, context, existing, { ownerId: memberId });
                if (updated.event) recorded.push(updated.event);
            }
            return existing;
        }
        const viaSlotline = rows.some((r) => r.event.bookedVia === 'slotline');
        const created = await this.store.createLead(
            tx,
            context,
            { address, displayName: rows.find((r) => r.displayName)?.displayName ?? '' },
            memberId,
            viaSlotline ? SLOTLINE_LEAD_SOURCE : CALENDAR_LEAD_SOURCE,
        );
        if (!created) {
            throw new ApiException(
                409,
                'conflict',
                'a deleted person has this address; restore them from the trash instead',
            );
        }
        recorded.push(created.event);
        return created.id;
    }

    /** The member a write acts for: the caller, or (an admin) the member named. */
    private actingFor(context: WorkspaceRunContext, requested: string | undefined): string {
        const memberId = memberInScope(context, requested) ?? context.memberId;
        if (!memberId) throw new ApiException(400, 'validation.failed', 'name the member the suggestion is for');
        return memberId;
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('LeadSuggestionsService is used inside a workspace scope');
        return context;
    }
}
