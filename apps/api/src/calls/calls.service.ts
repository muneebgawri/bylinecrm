import { Injectable } from '@nestjs/common';
import {
    e164Of,
    type CallDisposition,
    type CallRecording,
    type CallSummary,
    type CallSummaryText,
    type CallTranscriptLine,
    type CallView,
    type DomainEvent,
    type Phones,
    type RichText,
} from '@bylinecrm/shared';
import type { Call, Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, UnknownReference } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import { NotesService } from '../records/notes.service';
import { richTextToPlain } from '../records/rich-text';

/** What the Call panel logs: whom, which way, how it went, and the note. */
export interface LogCallInput {
    personId: string;
    direction: 'outbound' | 'inbound';
    disposition: CallDisposition;
    /** When the member started it; now when absent. */
    startedAt?: Date | undefined;
    durationSec?: number | null | undefined;
    note?: RichText | undefined;
}

/**
 * Calls (CALL-1): a member's own log from the Call panel — a `calls` row, the note on the person, `call.logged`
 * — and the outcome written onto any call, Quo's included. Quo's reports come in through `QuoHookService`,
 * which merges them into a log of the same call when there is one. Reading is by person, newest first.
 */
@Injectable()
export class CallsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly notes: NotesService,
    ) {}

    async log(input: LogCallInput): Promise<CallView> {
        const context = this.context.get()!;
        return this.rls.withWorkspace(async (tx) => {
            const person = await tx.person.findFirst({
                where: { id: input.personId, deletedAt: null },
                select: { id: true, phones: true },
            });
            if (!person) throw new UnknownReference('personId', 'no such person');
            const phones = person.phones as unknown as Phones;
            const number = e164Of(phones.primary) ?? phones.primary?.number ?? null;
            const noteId = await this.writeNote(tx, context, input.personId, input.note);
            const startedAt = input.startedAt ?? new Date();
            const row = await tx.call.create({
                data: {
                    workspaceId: context.workspaceId,
                    provider: 'manual',
                    personId: person.id,
                    memberId: context.memberId ?? null,
                    direction: input.direction,
                    status: 'logged',
                    fromNumber: input.direction === 'outbound' ? null : number,
                    toNumber: input.direction === 'outbound' ? number : null,
                    startedAt,
                    completedAt: input.durationSec ? new Date(startedAt.getTime() + input.durationSec * 1000) : null,
                    durationSec: input.durationSec ?? null,
                    disposition: input.disposition,
                    noteId,
                },
            });
            await this.events.record(tx, callEvent('call.logged', context, row));
            return view(row);
        });
    }

    /** The outcome and the note, on any call of the person's — a reviewer's correction too. */
    async patch(
        id: string,
        input: { disposition?: CallDisposition | null | undefined; note?: RichText | undefined },
    ): Promise<CallView> {
        const context = this.context.get()!;
        return this.rls.withWorkspace(async (tx) => {
            const existing = await tx.call.findUnique({ where: { id } });
            if (!existing) throw new ApiException(404, 'not_found', 'no such call');
            const noteId =
                existing.noteId ??
                (existing.personId ? await this.writeNote(tx, context, existing.personId, input.note) : null);
            if (existing.noteId && input.note) {
                const updated = await this.notes.updateIn(tx, context, existing.noteId, { body: input.note });
                if (updated.event) await this.events.record(tx, updated.event);
            }
            const row = await tx.call.update({
                where: { id },
                data: {
                    ...(input.disposition !== undefined ? { disposition: input.disposition } : {}),
                    noteId,
                },
            });
            await this.events.record(tx, callEvent('call.updated', context, row));
            return view(row);
        });
    }

    listForPerson(personId: string): Promise<CallView[]> {
        return this.rls.withWorkspace(async (tx) =>
            (await tx.call.findMany({ where: { personId }, orderBy: { startedAt: 'desc' }, take: 100 })).map(view),
        );
    }

    get(id: string): Promise<CallView> {
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.call.findUnique({ where: { id } });
            if (!row) throw new ApiException(404, 'not_found', 'no such call');
            return view(row);
        });
    }

    /** The Call panel's note on the person's timeline, titled as a call note; none for an empty note. */
    private async writeNote(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        personId: string,
        body: RichText | undefined,
    ): Promise<string | null> {
        if (!body || richTextToPlain(body).trim() === '') return null;
        const { row, event } = await this.notes.createIn(tx, context, {
            title: 'Call notes',
            body,
            targets: [{ type: 'person', id: personId }],
        });
        await this.events.record(tx, event);
        return row.id;
    }
}

/** A call's domain event: on the person (`targets`), with the call's summary. */
export function callEvent(
    type: 'call.logged' | 'call.updated',
    context: Pick<WorkspaceRunContext, 'workspaceId' | 'memberId' | 'apiKeyId' | 'actor'>,
    row: Call,
): DomainEvent {
    return {
        type,
        object: 'call',
        workspaceId: context.workspaceId,
        actor: actorOf(context as WorkspaceRunContext),
        occurredAt: new Date().toISOString(),
        recordId: row.id,
        targets: row.personId ? [{ type: 'person', id: row.personId }] : [],
        call: summaryOf(row),
    };
}

export function summaryOf(row: Call): CallSummary {
    const recordings = row.recordings as unknown as CallRecording[];
    const summary = row.summary as unknown as CallSummaryText | null;
    return {
        direction: row.direction,
        status: row.status,
        durationSec: row.durationSec,
        disposition: row.disposition,
        fromNumber: row.fromNumber,
        toNumber: row.toNumber,
        hasRecording: Array.isArray(recordings) && recordings.length > 0,
        summary: summary?.summary?.slice(0, 3) ?? null,
        quoLink: row.quoLink,
    };
}

export function view(row: Call): CallView {
    return {
        id: row.id,
        provider: row.provider === 'quo' ? 'quo' : 'manual',
        personId: row.personId,
        memberId: row.memberId,
        direction: row.direction,
        status: row.status,
        fromNumber: row.fromNumber,
        toNumber: row.toNumber,
        startedAt: row.startedAt.toISOString(),
        answeredAt: row.answeredAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        durationSec: row.durationSec,
        hasVoicemail: row.hasVoicemail,
        recordings: (row.recordings as unknown as CallRecording[] | null) ?? [],
        summary: (row.summary as unknown as CallSummaryText | null) ?? null,
        transcript: (row.transcript as unknown as CallTranscriptLine[] | null) ?? null,
        disposition: row.disposition,
        noteId: row.noteId,
        quoLink: row.quoLink,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

export type CallRow = Call;
export type CallUpdate = Prisma.CallUpdateInput;
