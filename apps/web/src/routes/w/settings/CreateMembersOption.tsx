import { SYSTEM_ROLES } from '@bylinecrm/shared';
import { Checkbox, Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bylinecrm/ui';
import { useId } from 'react';
import { useRoles } from '../../../api/team';

/** The accounts option's value: the role created accounts get. */
export interface CreateMembersChoice {
    roleId: string;
}

/**
 * The accounts option of an importer (#184 for Twenty, BIGIN-1 for Bigin): create a user and a seat for each
 * record owner in the source who is not a member here, with a role of the workspace's (`member` unless chosen
 * otherwise), so the records they own are theirs from this run. Nothing is mailed; an admin sends the
 * invitation from Members later.
 */
export function CreateMembersOption({
    workspaceId,
    source,
    value,
    onChange,
}: {
    workspaceId: string;
    /** The source's name as the label reads it: "Twenty", "Bigin". */
    source: string;
    value: CreateMembersChoice | null;
    onChange: (value: CreateMembersChoice | null) => void;
}) {
    const id = useId();
    const roles = useRoles(workspaceId);
    const memberRole = roles.data?.find((r) => r.isSystem && r.name === SYSTEM_ROLES.member) ?? roles.data?.[0];
    const on = value !== null;
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex items-start gap-2 text-[13px]">
                <Checkbox
                    id={`${id}-check`}
                    aria-labelledby={`${id}-label`}
                    checked={on}
                    disabled={!memberRole}
                    onCheckedChange={(checked) =>
                        onChange(checked === true && memberRole ? { roleId: memberRole.id } : null)
                    }
                />
                <label htmlFor={`${id}-check`} className="cursor-pointer">
                    <span id={`${id}-label`} className="font-medium">
                        Create accounts for {source} members who aren’t here
                    </span>
                    <span className="block text-text-muted">
                        Each gets an account with no password and a seat with the role below, so the records they own
                        are theirs. Nothing is emailed: send invitations from Members when you want them to sign in, or
                        they sign in with Google using that address. A scheduled sync creates accounts as last chosen
                        here, with this role.
                    </span>
                </label>
            </div>
            {on && (
                <Field label="Role for created accounts" className="max-w-xs">
                    <Select value={value.roleId} onValueChange={(roleId) => onChange({ roleId })}>
                        <SelectTrigger aria-label="Role for created accounts">
                            <SelectValue placeholder="Choose a role" />
                        </SelectTrigger>
                        <SelectContent>
                            {(roles.data ?? []).map((r) => (
                                <SelectItem key={r.id} value={r.id}>
                                    {r.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
            )}
        </div>
    );
}
