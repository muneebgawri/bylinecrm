import { Button, Input, toast } from '@bylinecrm/ui';
import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useAddCompanyDomain, useCompanyDomains, useRemoveCompanyDomain } from '../../../api/ownership';
import { useCan, useMembership, usePermission } from '../../../auth/capabilities';
import { RailCard, RailEmpty, RailLoading } from './RailCard';

/**
 * A company's other domains (OWN-2, #201): a person writing from one is at this company, and so is its
 * owner's. The company's owner, or a manager, adds and removes them; everyone else reads them.
 */
export function CompanyDomainsCard({
    workspaceId,
    companyId,
    ownerId,
}: {
    workspaceId: string;
    companyId: string;
    ownerId: string | null;
}) {
    const domains = useCompanyDomains(workspaceId, companyId);
    const add = useAddCompanyDomain(workspaceId, companyId);
    const remove = useRemoveCompanyDomain(workspaceId, companyId);
    const me = useMembership()?.memberId ?? null;
    const write = usePermission('record:write');
    const manager = useCan('record:transfer');
    const canEdit = write.allowed && (manager || ownerId === null || ownerId === me);
    const [value, setValue] = useState('');
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        try {
            await add.mutateAsync(value.trim());
            setValue('');
            setError(null);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not add it.');
        }
    };
    const items = domains.data ?? [];
    return (
        <RailCard title="Other domains" count={domains.data ? items.length : undefined}>
            {domains.isPending ? (
                <RailLoading />
            ) : items.length === 0 ? (
                <RailEmpty>
                    People writing from another of this company’s domains are matched to it once it’s here.
                </RailEmpty>
            ) : (
                <ul className="m-0 list-none p-0">
                    {items.map((d) => (
                        <li
                            key={d.domain}
                            className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm last:border-b-0"
                        >
                            <span className="break-all">{d.domain}</span>
                            {canEdit && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    shape="square"
                                    className="ml-auto"
                                    aria-label={`Remove ${d.domain}`}
                                    disabled={remove.isPending}
                                    onClick={() =>
                                        remove.mutate(d.domain, {
                                            onError: (err) =>
                                                toast({
                                                    tone: 'danger',
                                                    title:
                                                        err instanceof ApiError ? err.message : 'Could not remove it.',
                                                }),
                                        })
                                    }
                                >
                                    <X aria-hidden className="size-4" />
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {canEdit && (
                <form onSubmit={(e) => void submit(e)} className="grid gap-1.5 border-t border-border px-4 py-3">
                    <div className="flex gap-2">
                        <Input
                            aria-label="Add a domain"
                            placeholder="acme.co.uk"
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            autoComplete="off"
                        />
                        <Button type="submit" size="sm" shape="square" loading={add.isPending} disabled={!value.trim()}>
                            Add
                        </Button>
                    </div>
                    {error && (
                        <p role="alert" className="m-0 text-xs text-danger">
                            {error}
                        </p>
                    )}
                </form>
            )}
        </RailCard>
    );
}
