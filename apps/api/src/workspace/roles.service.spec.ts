import { CAPABILITIES, SYSTEM_ROLES } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { capabilitiesOf } from './roles.service';

describe('capabilitiesOf', () => {
    it('gives the system admin role every capability, whatever is stored', () => {
        const caps = capabilitiesOf({ name: SYSTEM_ROLES.admin, isSystem: true }, []);
        expect([...caps].sort()).toEqual([...CAPABILITIES].sort());
    });

    it('gives a custom role named "admin" only what is stored', () => {
        const caps = capabilitiesOf({ name: SYSTEM_ROLES.admin, isSystem: false }, ['deal:read']);
        expect([...caps]).toEqual(['deal:read']);
    });

    it('drops a stored string that is not in the catalogue', () => {
        const caps = capabilitiesOf({ name: 'sales', isSystem: false }, ['deal:read', 'not:a-capability']);
        expect([...caps]).toEqual(['deal:read']);
    });
});
