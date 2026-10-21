import { CAPABILITIES, MANAGER_DEFAULT_CAPABILITIES, MEMBER_DEFAULT_CAPABILITIES } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';

describe('the manager system role (OWN-1)', () => {
    it('FR-CRMS-18: a manager starts as a member plus moving records, bulk deals, export-all and guardrail review; a member can do none of those', () => {
        const manager = new Set(MANAGER_DEFAULT_CAPABILITIES);
        const member = new Set(MEMBER_DEFAULT_CAPABILITIES);

        // Everything a member can do, a manager can too: promotion never takes anything away.
        for (const capability of member) expect(manager.has(capability), capability).toBe(true);

        // What makes a manager: the forced-transfer path, bulk deal edits, every record's export, the review queue.
        for (const capability of ['record:transfer', 'deal:bulk', 'record:export_all', 'guardrail:review'] as const) {
            expect(manager.has(capability), capability).toBe(true);
            expect(member.has(capability), capability).toBe(false);
        }

        // Only real capabilities, each once — the roles are seeded from these lists as rows.
        const known = new Set<string>(CAPABILITIES);
        for (const list of [MANAGER_DEFAULT_CAPABILITIES, MEMBER_DEFAULT_CAPABILITIES]) {
            expect(new Set(list).size).toBe(list.length);
            for (const capability of list) expect(known.has(capability), capability).toBe(true);
        }
    });
});
