import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTableChrome, pageWindow } from './DataTableChrome';

describe('pageWindow', () => {
    it('keeps the current page in a three-wide window clamped to the range', () => {
        expect(pageWindow(1, 97)).toEqual([1, 2, 3]);
        expect(pageWindow(50, 97)).toEqual([49, 50, 51]);
        expect(pageWindow(97, 97)).toEqual([95, 96, 97]);
        expect(pageWindow(1, 2)).toEqual([1, 2]);
        expect(pageWindow(1, 1)).toEqual([1]);
    });
});

describe('DataTableChrome', () => {
    it('reports tab, search and page changes, and disables the edges', async () => {
        const user = userEvent.setup();
        const onTabChange = vi.fn();
        const onChange = vi.fn();
        const onPageChange = vi.fn();
        render(
            <DataTableChrome
                tabs={[
                    { id: 'all', label: 'All' },
                    { id: 'mine', label: 'My leads', count: 1204 },
                ]}
                activeTab="all"
                onTabChange={onTabChange}
                search={{ value: '', onChange, placeholder: 'Search people…' }}
                pagination={{ page: 1, pageCount: 3, onPageChange, pageSize: 50 }}
            >
                <table>
                    <tbody>
                        <tr>
                            <td>row</td>
                        </tr>
                    </tbody>
                </table>
            </DataTableChrome>,
        );
        expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
        await user.click(screen.getByRole('tab', { name: /My leads/ }));
        expect(onTabChange).toHaveBeenCalledWith('mine');

        await user.type(screen.getByRole('searchbox', { name: 'Search people…' }), 'd');
        expect(onChange).toHaveBeenCalledWith('d');

        expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Next' }));
        expect(onPageChange).toHaveBeenCalledWith(2);
        await user.click(screen.getByRole('button', { name: 'Page 3' }));
        expect(onPageChange).toHaveBeenCalledWith(3);
        expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });
});
