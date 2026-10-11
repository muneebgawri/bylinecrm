import type { Capability } from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt, route, stubApi } from '../settings/settingsTestKit';
import { PERSON, WS, mailbox, mailboxesRoute } from './mailTestKit';
import { RecordCompose, type RecordComposeHandle } from './RecordCompose';

const CAN_SEND: Capability[] = ['email:send', 'mailbox:read', 'record:read'];

/** `matchMedia` answering as a 375px phone with a finger, for the rest of the test. */
function setPhone() {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('max-width') || query.includes('pointer: coarse'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    }));
}

function Page() {
    const compose = useRef<RecordComposeHandle>(null);
    return (
        <>
            <button type="button" onClick={() => compose.current?.start()}>
                Email
            </button>
            <RecordCompose workspaceId={WS} person={PERSON} handle={compose} />
        </>
    );
}

afterEach(() => vi.unstubAllGlobals());

describe('FR-CRMS-UI-12: composing on a phone', () => {
    it('keeps the composer out of the page and opens it as a full-screen sheet from “Email”', async () => {
        setPhone();
        stubApi([mailboxesRoute([mailbox()])]);
        renderAt([route('/w/:workspaceId/people/:id', <Page />)], `/w/${WS}/people/${PERSON.id}`, CAN_SEND);
        expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Email' }));
        const sheet = await screen.findByRole('dialog', { name: 'Email Dana Reyes' });
        expect(sheet).toHaveClass('max-md:h-dvh');
        expect(await within(sheet).findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
        await userEvent.click(within(sheet).getByRole('button', { name: 'Discard' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows the composer inline on a desktop and “Email” puts the caret in it', async () => {
        stubApi([mailboxesRoute([mailbox()])]);
        renderAt([route('/w/:workspaceId/people/:id', <Page />)], `/w/${WS}/people/${PERSON.id}`, CAN_SEND);
        const subject = await screen.findByRole('textbox', { name: 'Subject' });
        await userEvent.click(screen.getByRole('button', { name: 'Email' }));
        // Tiptap moves focus on the next animation frame.
        await waitFor(() => expect(subject).toHaveFocus());
    });
});
