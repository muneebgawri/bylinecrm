import { BadRequestException } from '@nestjs/common';
import { CONTACT_STATUS_OVERRIDES, DEFAULT_LOST_REASON, lostReasonFromText } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { lostReasonFor } from '../pipelines/stage-move.service';
import { followUpPlan } from '../records/follow-up-task';
import { exclusionTarget } from './exclusion-target';

describe('#242 won deal exclusion target', () => {
    it('excludes the address by default', () => {
        expect(exclusionTarget('address', 'ana@acme.example', 'acme.example')).toEqual({ address: 'ana@acme.example' });
    });

    it('excludes the company domain when the workspace chose domain', () => {
        expect(exclusionTarget('domain', 'ana@mail.acme.example', 'Acme.example')).toEqual({ domain: 'acme.example' });
    });

    it("falls back to the address's own domain when there is no company domain", () => {
        expect(exclusionTarget('domain', 'ana@acme.example', null)).toEqual({ domain: 'acme.example' });
    });

    it('never excludes a free-mail domain whole: the address instead', () => {
        expect(exclusionTarget('domain', 'ana@gmail.com', null)).toEqual({ address: 'ana@gmail.com' });
        expect(exclusionTarget('domain', 'ana@acme.example', 'gmail.com')).toEqual({ address: 'ana@acme.example' });
    });

    it('has nothing to exclude without an address', () => {
        expect(exclusionTarget('domain', null, 'acme.example')).toBeNull();
    });
});

describe('#242 lost reason', () => {
    it('keeps the reason a member picked', () => {
        expect(lostReasonFor({ lostReasonCode: 'timing' }, 'manual')).toBe('timing');
    });

    it("refuses a member's close into a lost stage without a reason", () => {
        expect(() => lostReasonFor({}, 'manual')).toThrow(BadRequestException);
        expect(() => lostReasonFor(undefined, 'manual')).toThrow(BadRequestException);
    });

    it('gives a rule or an import the documented default', () => {
        expect(DEFAULT_LOST_REASON).toBe('other');
        expect(lostReasonFor(undefined, 'rule')).toBe('other');
        expect(lostReasonFor({ lostReason: undefined }, 'import')).toBe('other');
    });

    it('maps an imported free-text reason onto the picklist', () => {
        expect(lostReasonFor({ lostReason: 'No response' }, 'import')).toBe('no_response');
        expect(lostReasonFromText('NO_RESPONSE')).toBe('no_response');
        expect(lostReasonFromText('Too expensive for their budget')).toBe('price_budget');
        expect(lostReasonFromText('Went with a competitor')).toBe('chose_competitor');
        expect(lostReasonFromText('Duplicate')).toBe('duplicate_opportunity');
        expect(lostReasonFromText('Other')).toBe('other');
        expect(lostReasonFromText('something else entirely')).toBeNull();
        expect(lostReasonFromText('')).toBeNull();
    });
});

describe('#242 follow-up task', () => {
    const open = { id: 't1', open: true };
    const done = { id: 't1', open: false };
    const day = new Date('2026-11-02T00:00:00Z');

    it('makes a task for a new date', () => {
        expect(followUpPlan(day, null)).toEqual({ kind: 'create' });
    });

    it('moves the open task to a changed date', () => {
        expect(followUpPlan(day, open)).toEqual({ kind: 'reschedule', taskId: 't1' });
    });

    it('makes a new task when the last one is done', () => {
        expect(followUpPlan(day, done)).toEqual({ kind: 'create' });
    });

    it('removes the open task when the date is cleared, and leaves a done one', () => {
        expect(followUpPlan(null, open)).toEqual({ kind: 'remove', taskId: 't1' });
        expect(followUpPlan(null, done)).toEqual({ kind: 'none' });
        expect(followUpPlan(null, null)).toEqual({ kind: 'none' });
    });
});

describe('#242 contact status overrides', () => {
    it('never offers Do Not Contact as an override: that is the suppression list', () => {
        expect(CONTACT_STATUS_OVERRIDES).not.toContain('do_not_contact');
        expect(CONTACT_STATUS_OVERRIDES).toContain('customer');
    });
});
