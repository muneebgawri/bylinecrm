import { describe, expect, it } from 'vitest';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { readableBy } from './templates.service';

const as = (memberId: string | null, capabilities: string[] = []) =>
    ({ memberId, capabilities: new Set(capabilities) }) as unknown as WorkspaceRunContext;

describe('who reads a template', () => {
    it('a member: their own and the public ones', () => {
        expect(readableBy(as('m-1'))).toEqual({ OR: [{ visibility: 'public' }, { ownerMemberId: 'm-1' }] });
    });

    it('template:read_all, on any role: every one, an ownerless one included', () => {
        expect(readableBy(as('m-1', ['template:read_all']))).toEqual({});
        expect(readableBy(as(null, ['template:read_all']))).toEqual({});
    });

    it('workspace:admin alone grants nothing here: the admin role reads all because it holds every capability', () => {
        expect(readableBy(as('m-1', ['workspace:admin']))).toEqual({
            OR: [{ visibility: 'public' }, { ownerMemberId: 'm-1' }],
        });
    });

    it('no one (a key): the public ones only', () => {
        expect(readableBy(as(null))).toEqual({ visibility: 'public' });
    });
});
