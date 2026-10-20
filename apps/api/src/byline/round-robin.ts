/**
 * Who a lead at an unowned company is dealt to (BYL-1): the configured members still in the workspace, in the
 * configured order, taken in turn. `dealt` is how many leads the workspace has dealt so far, counting this one
 * (the settings row's cursor after its atomic increment). Null when nobody on the list is still a member: the lead
 * waits in the Leads queue, unowned.
 */
export function dealTo(configured: readonly string[], members: ReadonlySet<string>, dealt: number): string | null {
    const active = [...new Set(configured)].filter((id) => members.has(id));
    if (active.length === 0) return null;
    const position = (((dealt - 1) % active.length) + active.length) % active.length;
    return active[position]!;
}
