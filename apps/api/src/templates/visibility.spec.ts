import { describe, expect, it } from 'vitest';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { PreviewMailDto } from '../mail-send/dto';
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

describe('POST /mail/preview body', () => {
    const base = { mailboxId: crypto.randomUUID(), personId: crypto.randomUUID() };
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] };
    const parse = (input: object) => PreviewMailDto.schema.safeParse(input).success;

    it('takes a written body, with or without a subject yet', () => {
        expect(parse({ ...base, body })).toBe(true);
        expect(parse({ ...base, body, subject: 'Hello {{person.firstName}}', signature: null })).toBe(true);
    });

    it('takes a template alone, never a template and a body', () => {
        expect(parse({ ...base, templateId: crypto.randomUUID() })).toBe(true);
        expect(parse({ ...base, templateId: crypto.randomUUID(), body })).toBe(false);
        expect(parse({ ...base })).toBe(false);
    });

    it('takes nothing a send has that a preview does not: no recipients, no schedule', () => {
        expect(parse({ ...base, body, sendAt: new Date().toISOString() })).toBe(false);
    });
});
