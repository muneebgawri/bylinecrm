import { companyDomainOfAddress } from '@bylinecrm/shared';
import { useCreateRecord } from '../api/lists';
import { useCan } from '../auth/capabilities';

/**
 * A company picker's `onCreate`: makes the company typed into it, through the same `POST …/companies` and
 * the same `record:write` capability as "New company". Undefined for a member who may not create one.
 *
 * `address` is the record's person's address: when it is at a company domain (not free mail), the new
 * company gets that domain. Should a company already have it, the API refuses (`conflict.company_owned`)
 * and the picker offers that company instead of making a second one.
 */
export function useCompanyCreator(
    workspaceId: string,
    address?: string | null,
): ((name: string) => Promise<{ id: string; title: string }>) | undefined {
    const allowed = useCan('record:write');
    const create = useCreateRecord(workspaceId, 'company');
    if (!allowed) return undefined;
    const domain = companyDomainOfAddress(address);
    return async (name) => {
        // The body "New company" sends (ListDialogs): the generated schema misreads `domain` as a list.
        const company = await create.mutateAsync({ name, ...(domain ? { domain } : {}) } as never);
        return { id: company.id, title: company.name };
    };
}
