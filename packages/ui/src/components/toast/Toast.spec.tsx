import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Toaster, ToastStore, TOAST_LIMIT } from './Toast';

describe('ToastStore', () => {
    it('keeps the newest toasts only, up to the limit', () => {
        const store = new ToastStore();
        for (let i = 0; i < TOAST_LIMIT + 2; i++) store.push({ title: `t${i}` });
        expect(store.all().map((t) => t.title)).toEqual(['t2', 't3', 't4']);
    });

    it('dismisses by id and ignores an unknown id', () => {
        const store = new ToastStore();
        const id = store.push({ title: 'one' });
        store.dismiss(999);
        expect(store.all()).toHaveLength(1);
        store.dismiss(id);
        expect(store.all()).toHaveLength(0);
    });
});

describe('Toaster', () => {
    it('renders the store and removes a toast when it is dismissed', async () => {
        const store = new ToastStore();
        render(<Toaster store={store} />);
        store.push({ title: 'Move refused', description: 'Stage is not in this pipeline', tone: 'danger' });
        expect(await screen.findByText('Move refused')).toBeInTheDocument();
        expect(screen.getByText('Stage is not in this pipeline')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(store.all()).toHaveLength(0);
    });
});
