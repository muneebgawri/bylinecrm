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
        it('is what they asked for', () => {
            expect(resolveOwner(all, OTHER, undefined)).toBe(OTHER);
            expect(resolveOwner(all, null, ME)).toBeNull();
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
