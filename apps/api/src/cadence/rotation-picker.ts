/** A member as the rotation weighs them (CADENCE-1). */
export interface RotationCandidate {
    memberId: string;
    /** Their role's default, or an admin's choice. */
    included: boolean;
    paused: boolean;
    resumeAt: Date | null;
    weight: number;
    hasMailbox: boolean;
    openLeads: number;
}

export interface RotationRules {
    /** `prefer`, `require` or `ignore` (`MAILBOX_PREFERENCES`). */
    mailboxPreference: string;
    openLeadCap: number | null;
}

/** Whether a pause still holds at `now` (a pause with a resume date in the past has ended). */
export function pausedAt(c: Pick<RotationCandidate, 'paused' | 'resumeAt'>, now: Date): boolean {
    return c.paused && (c.resumeAt === null || c.resumeAt > now);
}

/** Who is dealt to at all: included, not paused, under the cap, and with a mailbox when one is required. */
export function eligible(
    candidates: readonly RotationCandidate[],
    rules: RotationRules,
    now: Date,
): RotationCandidate[] {
    const open = candidates.filter(
        (c) =>
            c.included &&
            !pausedAt(c, now) &&
            (rules.openLeadCap === null || c.openLeads < rules.openLeadCap) &&
            (rules.mailboxPreference !== 'require' || c.hasMailbox),
    );
    // Preferred: those with a mailbox, when anyone has one.
    if (rules.mailboxPreference === 'prefer' && open.some((c) => c.hasMailbox)) return open.filter((c) => c.hasMailbox);
    return open;
}

/**
 * One round of the rotation: each eligible member in a stable order (by id), repeated by weight, interleaved so a
 * weight-2 member takes two turns spread through the round rather than two in a row.
 */
export function round(members: readonly RotationCandidate[]): string[] {
    const sorted = [...members].sort((a, b) => a.memberId.localeCompare(b.memberId));
    const turns: string[] = [];
    const most = Math.max(0, ...sorted.map((m) => m.weight));
    for (let pass = 0; pass < most; pass++) for (const m of sorted) if (m.weight > pass) turns.push(m.memberId);
    return turns;
}

/**
 * The next turn from `cursor` (leads dealt so far) that is not excluded: the member and the cursor after them. Null
 * when every turn is excluded (or nobody is eligible); the cursor then stays.
 */
export function pick(
    turns: readonly string[],
    cursor: number,
    exclude: ReadonlySet<string>,
): { memberId: string; cursor: number } | null {
    for (let step = 0; step < turns.length; step++) {
        const at = cursor + step;
        const memberId = turns[((at % turns.length) + turns.length) % turns.length]!;
        if (!exclude.has(memberId)) return { memberId, cursor: at + 1 };
    }
    return null;
}
