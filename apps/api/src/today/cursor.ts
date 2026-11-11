import { BadRequestException } from '@nestjs/common';

/**
 * A Today section's keyset cursor: the last row's sort key (a moment) and id, opaque to the client. Each section
 * sorts by its own moment — when a reply arrived, when a follow-up fell due — with the id as the tie-break, so the
 * page after the cursor is `(key, id) > (cursor.key, cursor.id)` and costs the same at row 10 or row 10 000.
 */
export interface SectionCursor {
    key: Date;
    id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeSectionCursor(cursor: SectionCursor): string {
    return Buffer.from(JSON.stringify([cursor.key.toISOString(), cursor.id]), 'utf8').toString('base64url');
}

export function decodeSectionCursor(raw: string): SectionCursor {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        throw new BadRequestException('cursor is not valid');
    }
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new BadRequestException('cursor is not valid');
    const [key, id] = parsed as unknown[];
    const at = typeof key === 'string' ? new Date(key) : null;
    if (!at || Number.isNaN(at.getTime()) || typeof id !== 'string' || !UUID.test(id)) {
        throw new BadRequestException('cursor is not valid');
    }
    return { key: at, id };
}
