import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton } from '../skeleton/Skeleton';
import { LoadingRegion } from './LoadingRegion';

describe('LoadingRegion (P1-UI-12, #95)', () => {
    it('is a polite, busy status named for what is loading, its skeleton hidden from assistive tech', () => {
        render(
            <LoadingRegion label="Loading mail settings" className="grid gap-2">
                <Skeleton className="h-6" data-testid="bar" />
            </LoadingRegion>,
        );
        const region = screen.getByRole('status', { name: 'Loading mail settings' });
        expect(region).toHaveAttribute('aria-live', 'polite');
        expect(region).toHaveAttribute('aria-busy', 'true');
        expect(region).toHaveClass('grid');
        expect(screen.getByTestId('bar')).toHaveAttribute('aria-hidden');
    });

    it('holds a single bar when no skeleton is given', () => {
        render(<LoadingRegion label="Loading" />);
        expect(screen.getByRole('status', { name: 'Loading' }).children).toHaveLength(1);
    });
});
