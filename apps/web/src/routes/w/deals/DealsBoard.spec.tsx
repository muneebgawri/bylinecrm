import type { Announcements, DndContextProps, ScreenReaderInstructions } from '@dnd-kit/core';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardView, OpportunityView, StageView } from '../../../api/types';
import { DealsBoard } from './DealsBoard';

/** The props the board hands to dnd-kit, captured so the test reads exactly what dnd-kit would get. */
const captured: { props: DndContextProps | null } = { props: null };
vi.mock('@dnd-kit/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@dnd-kit/core')>();
    return {
        ...actual,
        DndContext: (props: DndContextProps) => {
            captured.props = props;
            return createElement(actual.DndContext, props);
        },
    };
});

const P = 'pipeline-1';
const NEW_ID = '24400e15-0000-4000-8000-000000000001';
const CONTACTED_ID = '24400e15-0000-4000-8000-000000000002';
const DEAL_ID = 'db80f38f-0000-4000-8000-0000000000aa';

const stage = (id: string, name: string, position: number): StageView => ({
    id,
    pipelineId: P,
    name,
    position,
    probability: 10,
    kind: 'open',
    daysThreshold: null,
    cadenceDays: null,
    colour: 'accent',
});
const STAGES = [stage(NEW_ID, 'New', 1), stage(CONTACTED_ID, 'Contacted', 2)];
const DEAL: OpportunityView = {
    id: DEAL_ID,
    name: 'Series B PR',
    pipelineId: P,
    stageId: NEW_ID,
    stageEnteredAt: '2026-10-07T00:00:00Z',
    daysInStage: 2,
    closedAt: null,
    lostReason: null,
    lostReasonCode: null,
    nextFollowUpDate: null,
    followUpTaskId: null,
    nextActivity: null,
    serviceInterest: null,
    leadSource: null,
    lastContactedAt: null,
    contactAttempts: 0,
    cadenceDueAt: null,
    cadenceOverdue: false,
    amount: { amountMinor: 1_200_000, currency: 'USD' },
    currency: 'USD',
    closeDate: null,
    probability: null,
    position: 1,
    ownerId: null,
    pointOfContactId: null,
    companyId: null,
    company: null,
    pointOfContact: null,
    owner: null,
    createdBy: { kind: 'member', id: 'm-1' },
    custom: {},
    deletedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
};
const BOARD: BoardView = {
    pipeline: {
        id: P,
        name: 'Sales pipeline',
        isDefault: true,
        position: 1,
        stages: STAGES,
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
    },
    columns: STAGES.map((s) => {
        const deals = s.id === NEW_ID ? [DEAL] : [];
        return {
            stage: s,
            count: deals.length,
            amountMinorByCurrency: deals.length ? { USD: 1_200_000 } : {},
            deals,
            hasMore: false,
        };
    }),
};

function renderBoard(board: BoardView = BOARD) {
    const announce = vi.fn<(text: string) => void>();
    captured.props = null;
    render(
        <DealsBoard
            board={board}
            canMove
            layout="lanes"
            touch={false}
            onMove={() => {}}
            onMoveSheet={() => {}}
            onOpen={() => {}}
            announce={announce}
            onShowList={() => {}}
        />,
    );
    // Read through a cast: TypeScript narrowed `captured.props` to null at the reset above, not knowing render set it.
    const props = captured.props as DndContextProps | null;
    const accessibility = props?.accessibility;
    return {
        announce,
        announcements: accessibility?.announcements as Announcements | undefined,
        instructions: accessibility?.screenReaderInstructions as ScreenReaderInstructions | undefined,
    };
}

const active = { id: DEAL_ID } as Parameters<Announcements['onDragStart']>[0]['active'];
const over = { id: CONTACTED_ID } as NonNullable<Parameters<Announcements['onDragEnd']>[0]['over']>;

describe('FR-CRMS-UI-8: the deals board announces drags by name, in the page’s one polite region', () => {
    it('gives dnd-kit announcements that speak deal and stage names, never ids', () => {
        const { announce, announcements } = renderBoard();
        expect(announcements, 'the board passes its own announcements to dnd-kit').toBeDefined();
        announcements!.onDragStart({ active });
        announcements!.onDragOver?.({ active, over });
        const spoken = announce.mock.calls.map(([text]) => text).join(' | ');
        expect(spoken).toContain('Series B PR');
        expect(spoken).toContain('Contacted');
        expect(spoken).not.toMatch(/db80f38f|24400e15/);
    });

    it("keeps dnd-kit's assertive live region silent: every announcement goes through the page's", () => {
        const { announcements } = renderBoard();
        expect(announcements!.onDragStart({ active })).toBeUndefined();
        expect(announcements!.onDragOver?.({ active, over })).toBeUndefined();
        expect(announcements!.onDragEnd({ active, over })).toBeUndefined();
    });

    it('replaces dnd-kit’s default instructions', () => {
        const { instructions } = renderBoard();
        expect(instructions?.draggable).toBeTruthy();
        expect(instructions?.draggable).not.toMatch(/sortable|press space bar to pick up the draggable/i);
    });
});

/** The board with the New stage's quiet threshold set, and the one deal at `days` in it. */
function boardAt(days: number, threshold: number | null): BoardView {
    const newStage = { ...STAGES[0]!, daysThreshold: threshold };
    const deal = { ...DEAL, daysInStage: days };
    return {
        ...BOARD,
        columns: BOARD.columns.map((c: BoardView['columns'][number]) =>
            c.stage.id === NEW_ID ? { ...c, stage: newStage, deals: [deal] } : c,
        ),
        pipeline: { ...BOARD.pipeline, stages: [newStage, STAGES[1]!] },
    };
}

describe('FR-CRMS-UI-3: a board card shows its days in stage and turns quiet only past the stage threshold', () => {
    it('shows the API’s days in stage; at the threshold it is not quiet, one day past it is', () => {
        const atThreshold = render(<DealsBoard {...boardProps(boardAt(5, 5))} />);
        expect(atThreshold.getByText('5d in stage')).toBeInTheDocument();
        expect(atThreshold.queryByText('⚠ Quiet')).toBeNull();
        expect(atThreshold.queryByText(/past threshold/)).toBeNull();
        atThreshold.unmount();

        const past = render(<DealsBoard {...boardProps(boardAt(6, 5))} />);
        expect(past.getByText('6d in stage')).toBeInTheDocument();
        expect(past.getByText('⚠ Quiet')).toBeInTheDocument();
        expect(past.getByText('6d · past threshold')).toBeInTheDocument();
        past.unmount();

        // A stage with no threshold never marks a card quiet, however long it sits.
        const none = render(<DealsBoard {...boardProps(boardAt(400, null))} />);
        expect(none.getByText('400d in stage')).toBeInTheDocument();
        expect(none.queryByText('⚠ Quiet')).toBeNull();
    });
});

function boardProps(board: BoardView) {
    return {
        board,
        canMove: true,
        layout: 'lanes' as const,
        touch: false,
        onMove: () => {},
        onMoveSheet: () => {},
        onOpen: () => {},
        announce: () => {},
        onShowList: () => {},
    };
}
