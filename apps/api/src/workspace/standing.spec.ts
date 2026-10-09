import { describe, expect, it } from 'vitest';
import { standingOf } from './workspace.controllers';

describe('standingOf', () => {
    it('reads a member’s standing from the guard’s decision, scope included', () => {
        expect(
            standingOf({
                workspaceId: 'w',
                userId: 'u',
                memberId: 'm',
                roleId: 'r',
                roleName: 'rep',
                capabilities: new Set(['record:read', 'record:write']),
                ownerScopeMemberId: 'm',
            }),
        ).toEqual({
            workspaceId: 'w',
            memberId: 'm',
            userId: 'u',
            apiKeyId: null,
            roleId: 'r',
            roleName: 'rep',
            recordScope: 'own',
            capabilities: ['record:read', 'record:write'],
        });
    });

    it('reads a key’s standing with no member and every-owner scope', () => {
        expect(
            standingOf({ workspaceId: 'w', apiKeyId: 'k', roleId: 'r', roleName: 'admin', capabilities: new Set() }),
        ).toMatchObject({ memberId: null, userId: null, apiKeyId: 'k', recordScope: 'all', capabilities: [] });
    });
});
