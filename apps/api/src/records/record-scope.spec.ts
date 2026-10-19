import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { ownerWhere, resolveOwner } from './record-scope';

const ME = 'member-me';
const OTHER = 'member-other';
const all: WorkspaceRunContext = { workspaceId: 'w', memberId: ME, capabilities: new Set() };
const own: WorkspaceRunContext = { ...all, ownerScopeMemberId: ME };
const key: WorkspaceRunContext = { workspaceId: 'w', apiKeyId: 'k', capabilities: new Set() };

describe('ownerWhere', () => {
    it('filters an own-scoped caller to their records and nobody else', () => {
        expect(ownerWhere(own)).toEqual({ ownerId: ME });
        expect(ownerWhere(all)).toEqual({});
        expect(ownerWhere(key)).toEqual({});
    });
});

describe('resolveOwner', () => {
    describe('FR-CRMS-17: changing an owner is a transfer (OWN-1)', () => {
        const manager: WorkspaceRunContext = { ...all, capabilities: new Set(['record:transfer']) };

        it('refuses a member without record:transfer who asks for a different owner on patch (422 USE_TRANSFER)', () => {
            expect(() => resolveOwner(all, OTHER, ME)).toThrow(/transfer/);
            expect(() => resolveOwner(all, null, ME)).toThrow(/transfer/);
        });

        it('lets them keep the owner as it is, pick any owner on create, and claim a record nobody owns', () => {
            expect(resolveOwner(all, ME, ME)).toBe(ME);
            expect(resolveOwner(all, OTHER, undefined)).toBe(OTHER);
            expect(resolveOwner(all, ME, null)).toBe(ME);
        });

        it('does not stand in the way of a job acting for the workspace (sync, import)', () => {
            const job: WorkspaceRunContext = {
                workspaceId: 'w',
                capabilities: new Set(),
                actor: { kind: 'import', id: 'r' },
            };
            expect(resolveOwner(job, OTHER, ME)).toBe(OTHER);
        });

        it('lets a holder of record:transfer change the owner directly', () => {
            expect(resolveOwner(manager, OTHER, ME)).toBe(OTHER);
            expect(resolveOwner(manager, null, ME)).toBeNull();
        });
    });

    describe('for an own-scoped caller', () => {
        it('is always themselves, on create and on patch', () => {
            expect(resolveOwner(own, undefined, undefined)).toBe(ME);
            expect(resolveOwner(own, undefined, ME)).toBe(ME);
            expect(resolveOwner(own, ME, ME)).toBe(ME);
        });

        it('refuses another owner, and refuses clearing the owner', () => {
            expect(() => resolveOwner(own, OTHER, undefined)).toThrow(ForbiddenException);
            expect(() => resolveOwner(own, null, ME)).toThrow(ForbiddenException);
        });
    });

    describe('for a caller who reaches every record', () => {
        it('is what they asked for on create; on patch a change of owner needs record:transfer (OWN-1)', () => {
            expect(resolveOwner(all, OTHER, undefined)).toBe(OTHER);
            expect(resolveOwner({ ...all, capabilities: new Set(['record:transfer']) }, null, ME)).toBeNull();
        });

        it('defaults to themselves on create and to the current owner on patch', () => {
            expect(resolveOwner(all, undefined, undefined)).toBe(ME);
            expect(resolveOwner(all, undefined, OTHER)).toBe(OTHER);
            expect(resolveOwner(all, undefined, null)).toBeNull();
        });

        it('defaults to no owner when the caller is a key', () => {
            expect(resolveOwner(key, undefined, undefined)).toBeNull();
        });
    });
});
