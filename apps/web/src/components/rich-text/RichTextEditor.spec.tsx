import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichTextEditor } from './RichTextEditor';

const EMPTY_SUBJECT = { type: 'doc', content: [{ type: 'paragraph' }] } as const;

/**
 * FR-CRMS-UI-12: on a phone every control is a finger's 44px. The one-line subject editor drew
 * text plus padding and nothing more, so its height followed the font's metrics — 37px on the CI
 * runner (the routes gate's touch-target rule caught it on the template route). Its height is now
 * the touch target, whatever the font.
 */
describe('FR-CRMS-UI-12: the one-line subject editor on a phone', () => {
    it('is at least the 44px touch target tall, not just its text and padding', async () => {
        render(
            <RichTextEditor profile="subject" aria-label="Subject" value={EMPTY_SUBJECT} onChange={() => undefined} />,
        );
        expect(await screen.findByRole('textbox', { name: 'Subject' })).toHaveClass('max-md:min-h-touch');
    });
});
