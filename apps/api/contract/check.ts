/**
 * The client contract (P1-1c): `openapi.json` must be enough to generate a typed client. CI
 * generates `contract/generated/schema.d.ts` with openapi-typescript from the committed document
 * and type-checks this file against it. Nothing here runs; if the document stops describing these
 * responses, workspace parameters or ids, `tsc` fails the `test` job.
 */
import createClient from 'openapi-fetch';
import type { components, paths } from './generated/schema';

type Person = components['schemas']['Person'];
type Board = components['schemas']['Board'];
type Standing = components['schemas']['Standing'];

const client = createClient<paths>({ baseUrl: 'http://localhost' });
const workspaceId = '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';

export async function contract(): Promise<void> {
    const people = await client.GET('/api/w/{workspaceId}/people', {
        params: { path: { workspaceId }, query: { limit: 10 } },
    });
    if (people.data) {
        const first: Person | undefined = people.data.items[0];
        const cursor: string | null = people.data.nextCursor;
        const createdAt: string | undefined = first?.createdAt;
        void [cursor, createdAt];
    }

    const board = await client.GET('/api/w/{workspaceId}/pipelines/{pipelineId}/board', {
        params: { path: { workspaceId, pipelineId: workspaceId } },
    });
    if (board.data) {
        const value: Board = board.data;
        const counts: number[] = value.columns.map((column) => column.count);
        void counts;
    }

    const me = await client.GET('/api/w/{workspaceId}/me', { params: { path: { workspaceId } } });
    if (me.data) {
        const standing: Standing = me.data;
        void standing.capabilities;
    }
    if (me.error) {
        const message: string | string[] = me.error.message;
        void message;
    }
}
