import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../.storybook/modes';

const meta = { title: 'Foundations/Tokens' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const swatches: Array<[string, string]> = [
    ['background', 'bg-background'],
    ['surface', 'bg-surface'],
    ['surface-raised', 'bg-surface-raised'],
    ['border', 'bg-border'],
    ['accent', 'bg-accent'],
    ['accent-soft', 'bg-accent-soft'],
    ['success-soft', 'bg-success-soft'],
    ['warning-soft', 'bg-warning-soft'],
    ['danger-soft', 'bg-danger-soft'],
    ['info-soft', 'bg-info-soft'],
];

/** Every semantic colour, radius and type size, as the utilities that reach them. */
export const Gallery: Story = {
    render: () => (
        <div className="grid gap-8">
            <section>
                <h2 className="mb-3 text-sm font-medium text-text-muted">Colour</h2>
                <ul className="grid grid-cols-5 gap-3 text-xs">
                    {swatches.map(([name, cls]) => (
                        <li key={name} className="grid gap-1">
                            <div className={`h-12 rounded-md border border-border ${cls}`} />
                            <code>{name}</code>
                        </li>
                    ))}
                </ul>
            </section>
            <section className="grid gap-1 text-sm">
                <h2 className="mb-2 text-sm font-medium text-text-muted">Text</h2>
                <p className="text-text">text — primary copy</p>
                <p className="text-text-muted">text-muted — secondary copy, labels</p>
                <p className="text-text-faint">text-faint — placeholders, shortcuts</p>
                <p className="text-accent">accent — links, selected</p>
                <p className="text-success">success</p>
                <p className="text-warning">warning</p>
                <p className="text-danger">danger</p>
                <p className="text-info">info</p>
            </section>
            <section>
                <h2 className="mb-3 text-sm font-medium text-text-muted">Type scale</h2>
                <p className="text-xs">text-xs — badges, shortcuts</p>
                <p className="text-sm">text-sm — the product's body size</p>
                <p className="text-base">text-base — large controls</p>
                <p className="text-lg font-semibold">text-lg — dialog titles</p>
                <p className="text-2xl font-semibold">text-2xl — page titles</p>
                <p className="font-mono text-sm">font-mono — ids, code</p>
            </section>
            <section>
                <h2 className="mb-3 text-sm font-medium text-text-muted">Radius</h2>
                <div className="flex gap-3">
                    <div className="size-12 rounded-sm bg-accent-soft" />
                    <div className="size-12 rounded-md bg-accent-soft" />
                    <div className="size-12 rounded-lg bg-accent-soft" />
                    <div className="size-12 rounded-full bg-accent-soft" />
                </div>
            </section>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
