import { isContactReused } from './contact-reuse';

/**
 * Who a Bigin Contact held over time, reconstructed after the fact (FR-CRMS-26). The old Bigin → Twenty
 * job updated Twenty's name when a Contact was edited into someone else but often kept the old address, so
 * the person rows it left are mixed identities. This rebuilds the sequence from what history there is and
 * splits it with the sync's own rule (`isContactReused`); anything it cannot decide goes to review.
 */
export interface Identity {
    first: string;
    last: string;
    email: string | null;
}

/** A Twenty `person.updated` timeline entry whose diff touched the name and/or the emails. */
export interface TwentyChange {
    at: Date;
    name?: { before: { first: string; last: string } | null; after: { first: string; last: string } | null };
    email?: { before: string | null; after: string | null };
}

/** A full identity seen at an instant: a row of the old job's logs, or Bigin's current record. */
export interface Observation {
    at: Date;
    identity: Identity;
}

export interface Segment {
    identity: Identity;
    /** When the Contact started holding this person; null for the first. */
    from: Date | null;
}

export interface History {
    segments: Segment[];
    /** Changes the rule could not decide (a name change with the same address, no address at all): not split. */
    review: string[];
}

const fullName = (i: Identity) => [i.first, i.last].filter((p) => p).join(' ');
const sameEmail = (a: string | null, b: string | null) =>
    (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
const sameName = (a: Identity, b: Identity) =>
    fullName(a).replace(/\s+/g, ' ').toLowerCase() === fullName(b).replace(/\s+/g, ' ').toLowerCase();

/**
 * The people a Contact held, oldest first.
 *
 * - The first identity is the earliest "before" Twenty recorded; its address is the earliest address
 *   Twenty's diffs show, else one observed before the first change, else the holder's (the stale address the
 *   old job kept is the first person's).
 * - Every Twenty change starts a group; the logs and Bigin's current record that follow it, up to the next
 *   change, complete it (the old job's name change and the address it never wrote are one change).
 * - Consecutive groups are split when `isContactReused` says so. A name change with the same address, or a
 *   group with no address, is not split: it is reported for review.
 */
export function identityHistory(input: {
    holder: Identity;
    changes: readonly TwentyChange[];
    observations: readonly Observation[];
}): History {
    const changes = [...input.changes].sort((a, b) => a.at.getTime() - b.at.getTime());
    const observations = [...input.observations].sort((a, b) => a.at.getTime() - b.at.getTime());
    const firstChange = changes[0]?.at ?? null;
    const firstName = changes.find((c) => c.name?.before)?.name?.before ?? null;
    const firstEmail = changes.find((c) => c.email && c.email.before !== undefined)?.email?.before;
    const early = observations.find((o) => firstChange === null || o.at < firstChange);
    let state: Identity = {
        first: firstName?.first ?? early?.identity.first ?? input.holder.first,
        last: firstName?.last ?? early?.identity.last ?? input.holder.last,
        email: firstEmail !== undefined ? firstEmail : (early?.identity.email ?? input.holder.email),
    };
    // Observations before the first change describe the first person.
    for (const o of observations) if (firstChange === null || o.at < firstChange) state = { ...o.identity };

    const groups: Segment[] = [{ identity: state, from: null }];
    // Without Twenty's diffs (Twenty is gone), each full identity the logs or Bigin show that differs from the
    // one before is the change.
    if (changes.length === 0) {
        groups.length = 0;
        for (const o of observations) {
            const last = groups[groups.length - 1];
            if (last && sameName(last.identity, o.identity) && sameEmail(last.identity.email, o.identity.email))
                continue;
            groups.push({ identity: { ...o.identity }, from: last ? o.at : null });
        }
        if (groups.length === 0) groups.push({ identity: state, from: null });
    }
    changes.forEach((change, index) => {
        const next = changes[index + 1]?.at ?? null;
        let identity: Identity = { ...groups[groups.length - 1]!.identity };
        if (change.name?.after) identity = { ...identity, ...change.name.after };
        if (change.email) identity = { ...identity, email: change.email.after };
        for (const o of observations) {
            if (o.at >= change.at && (next === null || o.at < next)) identity = { ...o.identity };
        }
        groups.push({ identity, from: change.at });
    });

    const segments: Segment[] = [groups[0]!];
    const review: string[] = [];
    for (const group of groups.slice(1)) {
        const current = segments[segments.length - 1]!;
        if (isContactReused(toCheck(current.identity), toCheck(group.identity))) {
            segments.push(group);
            continue;
        }
        if (!sameName(current.identity, group.identity) && sameEmail(current.identity.email, group.identity.email)) {
            review.push(
                `name changed from "${fullName(current.identity)}" to "${fullName(group.identity)}" with the same address on ${group.from!.toISOString().slice(0, 10)}`,
            );
        } else if (!sameName(current.identity, group.identity) && (!current.identity.email || !group.identity.email)) {
            review.push(
                `name changed from "${fullName(current.identity)}" to "${fullName(group.identity)}" with no address to compare on ${group.from!.toISOString().slice(0, 10)}`,
            );
        }
        // Not split: the same person, as the latest record of them says.
        segments[segments.length - 1] = { identity: group.identity, from: current.from };
    }
    return { segments, review };
}

function toCheck(identity: Identity): { name: string; email: string | null } {
    return { name: fullName(identity), email: identity.email };
}
