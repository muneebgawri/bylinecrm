import { describe, expect, it, vi } from 'vitest';
import { makeDndAnnouncements, DND_INSTRUCTIONS } from './dnd-announcements';

const ITEMS: Record<string, string> = { 'db80f38f-1': 'Series B PR' };
const CONTAINERS: Record<string, string> = { 'st-new': 'New', 'st-contacted': 'Contacted' };

function setup(extra: Partial<Parameters<typeof makeDndAnnouncements>[0]> = {}) {
    const announce = vi.fn<(text: string) => void>();
    const announcements = makeDndAnnouncements({
        itemName: (id) => ITEMS[String(id)] ?? 'item',
        containerName: (id) => CONTAINERS[String(id)] ?? 'area',
        position: () => ({ index: 2, total: 9 }),
        announce,
        ...extra,
    });
    return { announce, announcements };
}

const active = { id: 'db80f38f-1' };
const over = { id: 'st-contacted' };

describe('FR-CRMS-UI-8: drag announcements speak names, through one polite region', () => {
    it('names the item and the place on pick-up, move and drop — never an id', () => {
        const { announce, announcements } = setup();
        announcements.onDragStart({ active });
        announcements.onDragOver?.({ active, over });
        announcements.onDragEnd({ active, over });
        announcements.onDragCancel({ active, over: null });
        const spoken = announce.mock.calls.map(([text]) => text);
        expect(spoken).toEqual([
            'Series B PR picked up.',
            'Series B PR over Contacted, position 3 of 9.',
            'Series B PR dropped in Contacted.',
            'Series B PR put back.',
        ]);
        for (const text of spoken) expect(text).not.toMatch(/db80f38f|st-contacted/);
    });

    it('returns nothing to dnd-kit, so its own assertive region stays silent', () => {
        const { announcements } = setup();
        expect(announcements.onDragStart({ active })).toBeUndefined();
        expect(announcements.onDragOver?.({ active, over })).toBeUndefined();
        expect(announcements.onDragMove?.({ active, over })).toBeUndefined();
        expect(announcements.onDragEnd({ active, over })).toBeUndefined();
        expect(announcements.onDragCancel({ active, over: null })).toBeUndefined();
    });

    it('says nothing while the pointer stays over the same place, and speaks when it leaves it', () => {
        const { announce, announcements } = setup();
        announcements.onDragOver?.({ active, over });
        announcements.onDragOver?.({ active, over });
        announcements.onDragOver?.({ active, over: null });
        expect(announce.mock.calls.map(([t]) => t)).toEqual([
            'Series B PR over Contacted, position 3 of 9.',
            'Series B PR is no longer over a drop area.',
        ]);
    });

    it('leaves the drop to the caller when it announces the outcome itself', () => {
        const { announce, announcements } = setup({ announceDrop: false });
        announcements.onDragEnd({ active, over });
        expect(announce).not.toHaveBeenCalled();
        announcements.onDragEnd({ active, over: null });
        expect(announce).toHaveBeenCalledWith('Series B PR put back.');
    });

    it('says "put back in" when the item is dropped where it came from', () => {
        const { announce, announcements } = setup({ announceDrop: false, isHome: (_a, o) => o === 'st-new' });
        announcements.onDragEnd({ active, over: { id: 'st-new' } });
        expect(announce).toHaveBeenCalledWith('Series B PR put back in New.');
    });

    it('omits the position when the caller cannot give one', () => {
        const { announce, announcements } = setup({ position: undefined });
        announcements.onDragOver?.({ active, over });
        expect(announce).toHaveBeenCalledWith('Series B PR over Contacted.');
    });

    it('instructions describe the keys, not an id', () => {
        expect(DND_INSTRUCTIONS.draggable).toMatch(/Space/);
        expect(DND_INSTRUCTIONS.draggable).not.toMatch(/[0-9a-f]{8}-/);
    });
});
