import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { CommandRegistry, commands } from '../../../commands/registry';
import { useRecordCommands } from './useRecordCommands';

function Record({ layout }: { layout: 'page' | 'drawer' }) {
    useRecordCommands({ layout, onNote: () => {}, onTask: () => {} });
    return null;
}

const ids = () => commands.all().map((c) => c.id);

describe('useRecordCommands', () => {
    it('registers the page record when no drawer is open', () => {
        const view = render(
            <MemoryRouter initialEntries={['/w/x/people/p']}>
                <Record layout="page" />
            </MemoryRouter>,
        );
        expect(ids()).toEqual(expect.arrayContaining(['record.note', 'record.task']));
        view.unmount();
        expect(ids().filter((id) => id.startsWith('record.'))).toEqual([]);
    });

    it('lets a drawer over a record page own the keys, without a duplicate registration', () => {
        // The regression: both registered `record.note` and the registry refused the second.
        const view = render(
            <MemoryRouter initialEntries={['/w/x/deals/d?open=company:00000000-0000-4000-8000-000000000000']}>
                <Record layout="page" />
                <Record layout="drawer" />
            </MemoryRouter>,
        );
        expect(ids().filter((id) => id.startsWith('record.'))).toEqual([]);
        expect(ids()).toEqual(expect.arrayContaining(['drawer.note', 'drawer.task']));
        view.unmount();
        expect(commands).toBeInstanceOf(CommandRegistry);
    });
});
