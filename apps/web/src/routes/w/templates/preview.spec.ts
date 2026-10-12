import { MISSING_POSTAL_ADDRESS } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { emailDocument } from '../../../components/EmailFrame';
import { resolutionLine, templateVariablePaths } from './preview';

const body = {
    type: 'doc' as const,
    content: [
        {
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Hi ' },
                { type: 'variable', attrs: { path: 'person.firstName' } },
                { type: 'text', text: ', about ' },
                { type: 'variable', attrs: { path: 'company.name' } },
            ],
        },
        { type: 'paragraph', content: [{ type: 'variable', attrs: { path: 'person.firstName' } }] },
    ],
};

describe('FR-CRMS-UI-5: template preview', () => {
    it('counts each distinct variable once, from the subject and the body', () => {
        expect(templateVariablePaths('Quick one for {{person.firstName}} {{deal.name}}', body)).toEqual([
            'person.firstName',
            'deal.name',
            'company.name',
        ]);
    });

    it('says every variable resolves when nothing is missing', () => {
        const line = resolutionLine({ missing: [], sendable: true }, 3, 'Dana Reyes');
        expect(line).toEqual({ tone: 'success', text: 'All 3 variables resolve for Dana Reyes.' });
    });

    it('names the empty variables, with how many of how many', () => {
        const line = resolutionLine(
            { missing: ['custom.lastHeadline', 'custom.lastOutlet'], sendable: false },
            6,
            'Dana Reyes',
        );
        expect(line).toEqual({
            tone: 'warning',
            text: '2 of 6 variables are empty for Dana Reyes: custom.lastHeadline, custom.lastOutlet.',
        });
    });

    it('reports a missing postal address on its own, not as a variable', () => {
        const line = resolutionLine({ missing: [MISSING_POSTAL_ADDRESS], sendable: false }, 2, 'Dana Reyes');
        expect(line.tone).toBe('warning');
        expect(line.text).toBe('The workspace postal address is not set, so this outreach email cannot be sent.');
    });

    it('says both when variables are empty and the postal address is missing', () => {
        const line = resolutionLine(
            { missing: ['deal.name', MISSING_POSTAL_ADDRESS], sendable: false },
            4,
            'Dana Reyes',
        );
        expect(line).toEqual({
            tone: 'warning',
            text: '1 of 4 variables is empty for Dana Reyes: deal.name. The workspace postal address is not set, so this outreach email cannot be sent.',
        });
    });

    it('says a template with no variables is ready', () => {
        expect(resolutionLine({ missing: [], sendable: true }, 0, 'Dana Reyes').text).toBe(
            'No variables to fill; ready for Dana Reyes.',
        );
    });

    it('wraps the rendered HTML in a complete document and adds no script', () => {
        const doc = emailDocument('<p>Hi <span data-missing-variable="person.city">{{person.city}}</span></p>');
        expect(doc.startsWith('<!doctype html>')).toBe(true);
        expect(doc).toContain('<p>Hi <span data-missing-variable="person.city">{{person.city}}</span></p>');
        expect(doc).not.toMatch(/<script/i);
        expect(doc).toContain('[data-missing-variable]');
        expect(doc).toContain("default-src 'none'");
    });
});
