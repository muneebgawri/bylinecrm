import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CardList, LONG_PRESS_MS, type CardListItem } from './CardList';

const ITEMS: CardListItem[] = [
    { id: 'p1', primary: 'Dana Reyes', secondary: ['Acme Corp'], meta: ['2h ago'] },
    { id: 'p2', primary: 'Sam Okafor', secondary: ['Initech'], meta: ['1d ago'] },
];

describe('CardList', () => {
    it('#82 draws the secondary line’s separators with CSS, so a wrapped line never starts with “·”', () => {
        render(
            <CardList
                aria-label="Mailboxes"
                items={[{ id: 'm', primary: 'dana@acme.example', secondary: ['Connected', 'Personal', 'You'] }]}
            />,
        );
        const line = screen.getByText('Personal').closest('[data-card-secondary]');
        expect(line).not.toBeNull();
        // No separator is a text node: the parts read as themselves, and the dot is a pseudo-element
        // the line's clip hides at the start of every line.
        expect(line!.textContent).toBe('ConnectedPersonalYou');
    });

    it('opens a card on tap, and is not a button when nothing opens', async () => {
        const user = userEvent.setup();
        const onOpen = vi.fn();
        const { rerender } = render(<CardList aria-label="People" items={ITEMS} onOpen={onOpen} />);
        await user.click(screen.getByRole('button', { name: /Dana Reyes/ }));
        expect(onOpen).toHaveBeenCalledWith('p1');
        rerender(<CardList aria-label="People" items={ITEMS} />);
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.getByRole('list', { name: 'People' })).toHaveTextContent('Acme Corp');
    });

    it('in select mode a tap toggles a checkbox card instead of opening it', async () => {
        const user = userEvent.setup();
        const onOpen = vi.fn();
        const onToggle = vi.fn();
        render(
            <CardList
                aria-label="People"
                items={ITEMS}
                onOpen={onOpen}
                selecting
                selected={new Set(['p2'])}
                onToggle={onToggle}
            />,
        );
        expect(screen.getByRole('checkbox', { name: /Sam Okafor/ })).toHaveAttribute('aria-checked', 'true');
        await user.click(screen.getByRole('checkbox', { name: /Dana Reyes/ }));
        expect(onToggle).toHaveBeenCalledWith('p1');
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('a long touch press starts select mode and the release does not open the card', () => {
        vi.useFakeTimers();
        try {
            const onOpen = vi.fn();
            const onStartSelecting = vi.fn();
            render(<CardList aria-label="People" items={ITEMS} onOpen={onOpen} onStartSelecting={onStartSelecting} />);
            const card = screen.getByRole('button', { name: /Dana Reyes/ });
            fireEvent.pointerDown(card, { pointerType: 'touch' });
            act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
            fireEvent.pointerUp(card);
            fireEvent.click(card);
            expect(onStartSelecting).toHaveBeenCalledWith('p1');
            expect(onOpen).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps actions beside the card body, not inside its button, and hides them while choosing', () => {
        const items = [{ ...ITEMS[0]!, actions: <button type="button">Actions for Dana Reyes</button> }];
        const { rerender } = render(<CardList aria-label="People" items={items} onOpen={() => {}} />);
        const actions = screen.getByRole('button', { name: 'Actions for Dana Reyes' });
        expect(screen.getByRole('button', { name: /^Dana Reyes/ })).not.toContainElement(actions);
        rerender(<CardList aria-label="People" items={items} onOpen={() => {}} selecting />);
        expect(screen.queryByRole('button', { name: 'Actions for Dana Reyes' })).not.toBeInTheDocument();
    });
});
