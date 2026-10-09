import type { FieldDescriptor, RecordObject, SavedView, ViewSort } from '@bylinecrm/shared';
import { Button, Skeleton } from '@bylinecrm/ui';
import { Popover, PopoverContent, PopoverTrigger } from '@bylinecrm/ui/popover';
import { Columns3, Download, Filter, ListFilter } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useCustomFields } from '../../../api/queries';
import { useMembership } from '../../../auth/capabilities';
import { ResponsivePanel } from '../../../components/ResponsivePanel';
import {
    conditionCount,
    draftProblem,
    filterableFields,
    fromFilter,
    toFilter,
    type DraftGroup,
} from '../../../lib/filterModel';
import { ColumnChooser, SortEditor, type ColumnChoice } from './ListEditors';
import { LIST_COPY } from './listConfig';

const FilterBuilder = lazy(() => import('./FilterBuilder'));

/**
 * The fields a member may filter an object's list by: its standard and live custom fields, less
 * the owner for a member whose role sees only their own records — their list is theirs already, so
 * an owner condition could only narrow it to nothing (the one place this rule lives; P1-UI-6).
 */
export function useFilterFields(workspaceId: string, object: RecordObject): FieldDescriptor[] {
    const customFields = useCustomFields(workspaceId, object);
    const membership = useMembership();
    const ownScoped = membership?.recordScope === 'own';
    return useMemo(
        () => filterableFields(object, customFields.data ?? []).filter((f) => !(ownScoped && f.name === 'ownerId')),
        [object, customFields.data, ownScoped],
    );
}

export interface ListToolbarProps {
    object: RecordObject;
    workspaceId: string;
    fields: readonly FieldDescriptor[];
    filter: SavedView['filter'];
    onFilter: (next: SavedView['filter']) => void;
    sorts: ViewSort[];
    onSorts: (next: ViewSort[]) => void;
    /** The column chooser, for a rendering that has columns (a table on a desktop); omitted, no chooser. */
    columns?: {
        shown: readonly string[];
        all: readonly { field: string; label: string }[];
        locked: readonly string[];
        onChange: (next: ColumnChoice[]) => void;
    };
    /** Member id → name, for an owner condition's choices. */
    members: ReadonlyMap<string, string>;
    phone: boolean;
    onExport: () => Promise<void>;
}

/**
 * Filter, sort, columns and export for every list (P1-UI-2, shared by deals since P1-UI-6): the
 * filter builder and sort editor open in a popover on a desktop and as a bottom sheet on a phone
 * (`ResponsivePanel`); the column chooser is desktop-only, because cards have no columns.
 */
export function ListToolbar({
    object,
    workspaceId,
    fields,
    filter,
    onFilter,
    sorts,
    onSorts,
    columns,
    members,
    phone,
    onExport,
}: ListToolbarProps) {
    const [filterOpen, setFilterOpen] = useState(false);
    const [draft, setDraft] = useState<DraftGroup>(() => fromFilter(filter));
    const [sortOpen, setSortOpen] = useState(false);
    const [sortDraft, setSortDraft] = useState<ViewSort[]>(sorts);
    const [exporting, setExporting] = useState(false);
    const count = conditionCount(filter);
    const problem = draftProblem(draft);
    const plural = LIST_COPY[object].plural;
    const choices: ColumnChoice[] = columns
        ? [
              ...columns.shown.flatMap((field) => {
                  const c = columns.all.find((x) => x.field === field);
                  return c ? [{ ...c, visible: true, locked: columns.locked.includes(field) }] : [];
              }),
              ...columns.all
                  .filter((c) => !columns.shown.includes(c.field))
                  .map((c) => ({ ...c, visible: false, locked: false })),
          ]
        : [];

    return (
        <>
            <ResponsivePanel
                title={`Filter ${plural}`}
                open={filterOpen}
                onOpenChange={(o) => {
                    if (o) setDraft(fromFilter(filter));
                    setFilterOpen(o);
                }}
                trigger={
                    <Button size="sm" shape="square" variant={count ? 'accent' : 'secondary'}>
                        <Filter aria-hidden /> Filter{count ? ` · ${count}` : ''}
                    </Button>
                }
                footer={
                    <>
                        <Button
                            shape="square"
                            className="max-md:flex-1"
                            onClick={() => {
                                onFilter(null);
                                setFilterOpen(false);
                            }}
                        >
                            Clear
                        </Button>
                        <Button
                            shape="square"
                            variant="primary"
                            className="max-md:flex-1"
                            disabled={problem !== null}
                            title={problem ?? undefined}
                            onClick={() => {
                                onFilter(toFilter(draft));
                                setFilterOpen(false);
                            }}
                        >
                            {phone ? 'Show results' : 'Apply'}
                        </Button>
                    </>
                }
            >
                <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                    <FilterBuilder
                        workspaceId={workspaceId}
                        fields={fields}
                        value={draft}
                        onChange={setDraft}
                        members={members}
                    />
                </Suspense>
                {problem && (
                    <p role="alert" className="m-0 text-sm text-danger">
                        {problem}
                    </p>
                )}
            </ResponsivePanel>

            <ResponsivePanel
                title={`Sort ${plural}`}
                open={sortOpen}
                onOpenChange={(o) => {
                    if (o) setSortDraft(sorts);
                    setSortOpen(o);
                }}
                widthClass="w-[min(28rem,calc(100vw-2rem))]"
                trigger={
                    <Button size="sm" shape="square">
                        <ListFilter aria-hidden /> Sort{sorts.length ? ` · ${sorts.length}` : ''}
                    </Button>
                }
                footer={
                    <Button
                        shape="square"
                        variant="primary"
                        className="max-md:flex-1"
                        onClick={() => {
                            onSorts(sortDraft);
                            setSortOpen(false);
                        }}
                    >
                        Apply
                    </Button>
                }
            >
                <SortEditor fields={fields} value={sortDraft} onChange={setSortDraft} />
            </ResponsivePanel>

            {columns && !phone && (
                <Popover>
                    <PopoverTrigger asChild>
                        <Button size="sm" shape="square">
                            <Columns3 aria-hidden /> Columns
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent aria-label="Columns" className="w-72">
                        <ColumnChooser choices={choices} onChange={columns.onChange} />
                    </PopoverContent>
                </Popover>
            )}

            <Button
                size="sm"
                shape="square"
                loading={exporting}
                onClick={() => {
                    setExporting(true);
                    void onExport().finally(() => setExporting(false));
                }}
            >
                <Download aria-hidden /> Export
            </Button>
        </>
    );
}
