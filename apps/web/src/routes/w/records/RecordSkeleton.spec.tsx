import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecordSkeleton } from './RecordPages';

/**
 * The route gate's axe check met the drawer while its record was still loading (CI run
 * 38115694159, tablet-dark): `aria-label` on a plain `div` is a prohibited attribute. The loading
 * region is a named status, like every other loading state in the app.
 */
describe('FR-CRMS-UI-8: the record skeleton', () => {
    it.each(['page', 'drawer'] as const)('is a named, busy status region (%s)', (layout) => {
        render(<RecordSkeleton layout={layout} />);
        expect(screen.getByRole('status', { name: 'Loading record' })).toHaveAttribute('aria-busy', 'true');
    });
});
