import { WON_DEAL_EXCLUSION_SOURCE, type OutreachExclusionView, type WonExclusionScope } from '@bylinecrm/shared';
import {
    Badge,
    DataTableChrome,
    DropdownMenuItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    toast,
} from '@bylinecrm/ui';
import {
    useCustomerExclusionSettings,
    useDismissReview,
    useExclusions,
    useRemoveExclusion,
    useSetCustomerExclusionSettings,
} from '../../../api/customers';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

const REVIEW_TEXT: Readonly<Record<NonNullable<OutreachExclusionView['reviewReason']>, string>> = {
    deal_reopened: 'Deal reopened',
    deal_refunded: 'Deal refunded',
};

/**
 * #242: who outreach treats as a customer. A won deal excludes its contact on its own; this page says what it
 * excludes (the address or the company's domain) and lists the exclusions, with the ones a reopened or refunded deal
 * flagged for an admin first. Nothing is removed without an admin.
 */
export function Customers() {
    const workspaceId = useWorkspaceId();
    const settings = useCustomerExclusionSettings(workspaceId);
    const setSettings = useSetCustomerExclusionSettings(workspaceId);
    const exclusions = useExclusions(workspaceId);
    const dismiss = useDismissReview(workspaceId);
    const remove = useRemoveExclusion(workspaceId);
    if (settings.isError) throw settings.error;
    if (exclusions.isError) throw exclusions.error;
    const rows = [...(exclusions.data ?? [])].sort(
        (a, b) => Number(b.reviewReason !== null) - Number(a.reviewReason !== null),
    );

    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID}>
            <p className="m-0 mb-3 max-w-[65ch] text-[13px] text-text-muted">
                When a deal is won, its point of contact is excluded from outreach so no cold sequence reaches a
                customer. If the deal is reopened or refunded, the exclusion stays and is flagged here for you.
            </p>
            <div className="mb-6 flex flex-wrap items-center gap-3">
                <label htmlFor="won-scope" className="text-[13px] text-text">
                    A won deal excludes
                </label>
                <Select
                    value={settings.data?.wonExclusionScope ?? 'address'}
                    disabled={settings.isPending || setSettings.isPending}
                    onValueChange={(v) =>
                        setSettings.mutate(
                            { wonExclusionScope: v as WonExclusionScope },
                            { onError: (e) => toast({ title: failureText(e), tone: 'danger' }) },
                        )
                    }
                >
                    <SelectTrigger id="won-scope" className="w-72">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="address">The contact’s address</SelectItem>
                        <SelectItem value="domain">The company’s whole domain</SelectItem>
                    </SelectContent>
                </Select>
                <span className="text-[12px] text-text-muted">
                    Free-mail domains such as gmail.com fall back to the address.
                </span>
            </div>
            <DataTableChrome
                data={{
                    label: 'Outreach exclusions',
                    loading: exclusions.isPending,
                    rows,
                    getRowId: (row) => row.id,
                    columns: [
                        {
                            id: 'who',
                            header: 'Address or domain',
                            className: 'font-medium',
                            cell: (row) => row.address ?? `@${row.domain}`,
                        },
                        {
                            id: 'source',
                            header: 'Source',
                            muted: true,
                            cell: (row) => (row.source === WON_DEAL_EXCLUSION_SOURCE ? 'Won deal' : row.source),
                        },
                        {
                            id: 'review',
                            header: 'Review',
                            cell: (row) =>
                                row.reviewReason ? (
                                    <Badge status="warning">{REVIEW_TEXT[row.reviewReason]}</Badge>
                                ) : (
                                    '—'
                                ),
                        },
                        {
                            id: 'created',
                            header: 'Added',
                            muted: true,
                            phone: 'hidden',
                            cell: (row) => formatDate(row.createdAt),
                        },
                    ],
                    rowActions: {
                        label: (row) => row.address ?? row.domain ?? 'Exclusion',
                        items: (row) => (
                            <>
                                {row.reviewReason && (
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            dismiss.mutate(row.id, {
                                                onError: (e) => toast({ title: failureText(e), tone: 'danger' }),
                                            })
                                        }
                                    >
                                        Keep excluded
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                    destructive
                                    onSelect={() =>
                                        remove.mutate(
                                            {
                                                id: row.id,
                                                note: row.reviewReason
                                                    ? `${REVIEW_TEXT[row.reviewReason]}: removed on review`
                                                    : 'Removed by an admin',
                                            },
                                            { onError: (e) => toast({ title: failureText(e), tone: 'danger' }) },
                                        )
                                    }
                                >
                                    Remove exclusion
                                </DropdownMenuItem>
                            </>
                        ),
                    },
                }}
            />
        </section>
    );
}
