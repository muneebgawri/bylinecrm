import { ID_FIELD } from '@bylinecrm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { encodeFilter } from '../lib/filterParam';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import { people } from './records';
import type {
    CreateSequenceInput,
    EnrolInput,
    EnrolmentBatchView,
    PreviewEnrolInput,
    PutSequenceStepsInput,
    SequenceEnrolmentView,
    SequenceView,
    StopEnrolmentInput,
    UpdateSequenceInput,
} from './types';

/**
 * Sequences and their enrolments (P3-3, P3-UI-1). They live apart from `queries.ts` so they load
 * with the sequences, record and list chunks that use them, never in the first load (#131).
 */
export const sequences = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<SequenceView[]>('GET', workspacePath(workspaceId, '/sequences'), { signal }),
    get: (workspaceId: string, sequenceId: string, signal?: AbortSignal) =>
        request<SequenceView>('GET', workspacePath(workspaceId, `/sequences/${sequenceId}`), { signal }),
    create: (workspaceId: string, input: CreateSequenceInput) =>
        request<SequenceView>('POST', workspacePath(workspaceId, '/sequences'), { body: input }),
    update: (workspaceId: string, sequenceId: string, input: UpdateSequenceInput) =>
        request<SequenceView>('PATCH', workspacePath(workspaceId, `/sequences/${sequenceId}`), { body: input }),
    /** Replaces the whole step list: the builder saves the order it shows. */
    putSteps: (workspaceId: string, sequenceId: string, input: PutSequenceStepsInput) =>
        request<SequenceView>('PUT', workspacePath(workspaceId, `/sequences/${sequenceId}/steps`), { body: input }),
    transition: (workspaceId: string, sequenceId: string, action: SequenceTransition) =>
        request<SequenceView>('POST', workspacePath(workspaceId, `/sequences/${sequenceId}/${action}`)),
    enrolments: (workspaceId: string, sequenceId: string, signal?: AbortSignal) =>
        request<SequenceEnrolmentView[]>('GET', workspacePath(workspaceId, `/sequences/${sequenceId}/enrolments`), {
            signal,
        }),
    /** What enrolling would do, person by person, with the server's reasons; nothing is enrolled. */
    preview: (workspaceId: string, sequenceId: string, input: PreviewEnrolInput) =>
        request<EnrolmentBatchView>('POST', workspacePath(workspaceId, `/sequences/${sequenceId}/enrolments/preview`), {
            body: input,
        }),
    enrol: (workspaceId: string, sequenceId: string, input: EnrolInput) =>
        request<EnrolmentBatchView>('POST', workspacePath(workspaceId, `/sequences/${sequenceId}/enrolments`), {
            body: input,
        }),
    personEnrolments: (workspaceId: string, personId: string, signal?: AbortSignal) =>
        request<SequenceEnrolmentView[]>('GET', workspacePath(workspaceId, `/people/${personId}/enrolments`), {
            signal,
        }),
    stop: (workspaceId: string, enrolmentId: string, input: StopEnrolmentInput) =>
        request<SequenceEnrolmentView>('POST', workspacePath(workspaceId, `/enrolments/${enrolmentId}/stop`), {
            body: input,
        }),
    resume: (workspaceId: string, enrolmentId: string) =>
        request<SequenceEnrolmentView>('POST', workspacePath(workspaceId, `/enrolments/${enrolmentId}/resume`)),
    reenrol: (workspaceId: string, enrolmentId: string) =>
        request<SequenceEnrolmentView>('POST', workspacePath(workspaceId, `/enrolments/${enrolmentId}/reenrol`)),
};

/** A sequence's status changes, each its own route on the API. */
export type SequenceTransition = 'activate' | 'pause' | 'resume' | 'archive';

export const useSequences = (workspaceId: string, enabled = true) =>
    useQuery({
        queryKey: keys.sequences(workspaceId),
        queryFn: ({ signal }) => sequences.list(workspaceId, signal),
        enabled,
    });

export const useSequence = (workspaceId: string, sequenceId: string) =>
    useQuery({
        queryKey: keys.sequence(workspaceId, sequenceId),
        queryFn: ({ signal }) => sequences.get(workspaceId, sequenceId, signal),
    });

export const useSequenceEnrolments = (workspaceId: string, sequenceId: string) =>
    useQuery({
        queryKey: keys.sequenceEnrolments(workspaceId, sequenceId),
        queryFn: ({ signal }) => sequences.enrolments(workspaceId, sequenceId, signal),
    });

export const usePersonEnrolments = (workspaceId: string, personId: string, enabled = true) =>
    useQuery({
        queryKey: keys.personEnrolments(workspaceId, personId),
        queryFn: ({ signal }) => sequences.personEnrolments(workspaceId, personId, signal),
        enabled,
    });

/** Every write here refreshes every sequence view of the workspace: lists, counts and enrolments. */
function useSequenceWrite<V, R>(workspaceId: string, write: (vars: V) => Promise<R>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: () => client.invalidateQueries({ queryKey: keys.sequences(workspaceId) }),
    });
}

export const useCreateSequence = (workspaceId: string) =>
    useSequenceWrite(workspaceId, (input: CreateSequenceInput) => sequences.create(workspaceId, input));

export const useUpdateSequence = (workspaceId: string, sequenceId: string) =>
    useSequenceWrite(workspaceId, (input: UpdateSequenceInput) => sequences.update(workspaceId, sequenceId, input));

export const usePutSequenceSteps = (workspaceId: string, sequenceId: string) =>
    useSequenceWrite(workspaceId, (input: PutSequenceStepsInput) => sequences.putSteps(workspaceId, sequenceId, input));

export const useSequenceTransition = (workspaceId: string, sequenceId: string) =>
    useSequenceWrite(workspaceId, (action: SequenceTransition) =>
        sequences.transition(workspaceId, sequenceId, action),
    );

/** The preview is a read that takes a body: it changes nothing, so it invalidates nothing. */
export const usePreviewEnrol = (workspaceId: string, sequenceId: string) =>
    useMutation({ mutationFn: (input: PreviewEnrolInput) => sequences.preview(workspaceId, sequenceId, input) });

export const useEnrol = (workspaceId: string, sequenceId: string) =>
    useSequenceWrite(workspaceId, (input: EnrolInput) => sequences.enrol(workspaceId, sequenceId, input));

export const useStopEnrolment = (workspaceId: string) =>
    useSequenceWrite(workspaceId, ({ id, note }: { id: string; note?: string | undefined }) =>
        sequences.stop(workspaceId, id, { note }),
    );

export const useResumeEnrolment = (workspaceId: string) =>
    useSequenceWrite(workspaceId, (id: string) => sequences.resume(workspaceId, id));

export const useReenrol = (workspaceId: string) =>
    useSequenceWrite(workspaceId, (id: string) => sequences.reenrol(workspaceId, id));

/**
 * The names of the people a sequence view lists, in one request: the people list filtered to their
 * ids (the API caps a page at the enrol batch size, 500). Names only — the rows link to the record.
 */
export function usePeopleNames(workspaceId: string, ids: readonly string[]) {
    const unique = [...new Set(ids)].sort();
    return useQuery({
        queryKey: [...keys.sequences(workspaceId), 'people', unique] as const,
        enabled: unique.length > 0,
        queryFn: async ({ signal }) => {
            const page = await people.list(
                workspaceId,
                {
                    limit: unique.length,
                    filter: encodeFilter({ and: [{ field: ID_FIELD.name, op: 'in', value: unique }] }),
                },
                signal,
            );
            return new Map(
                page.items.map((p) => [
                    p.id,
                    `${p.nameFirst} ${p.nameLast}`.trim() || p.emails.primary || 'Unnamed person',
                ]),
            );
        },
        staleTime: 60_000,
    });
}
