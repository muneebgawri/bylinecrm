/**
 * The header block of a message as it arrives on the wire (RFC 5322 §2.2): the relay judges a message by its
 * envelope and a few headers, and never reads the body. Names are compared lower-cased; folded lines are joined;
 * values keep their whitespace trimmed at the ends. Parsing stops at the first empty line.
 */
export class MessageHeaders {
    private constructor(
        private readonly fields: ReadonlyMap<string, readonly string[]>,
        /** Where the body starts (the byte after the empty line), or the data's length when there is none. */
        readonly bodyOffset: number,
    ) {}

    static parse(data: Buffer): MessageHeaders {
        const fields = new Map<string, string[]>();
        let name: string | null = null;
        let value = '';
        let offset = 0;
        const flush = (): void => {
            if (name === null) return;
            const list = fields.get(name) ?? [];
            list.push(value.trim());
            fields.set(name, list);
            name = null;
            value = '';
        };
        while (offset < data.length) {
            let end = data.indexOf(0x0a, offset);
            const next = end === -1 ? data.length : end + 1;
            if (end === -1) end = data.length;
            const lineEnd = end > offset && data[end - 1] === 0x0d ? end - 1 : end;
            const line = data.toString('latin1', offset, lineEnd);
            offset = next;
            if (line === '') {
                flush();
                return new MessageHeaders(fields, offset);
            }
            if ((line.startsWith(' ') || line.startsWith('\t')) && name !== null) {
                value += ` ${line.trim()}`;
                continue;
            }
            flush();
            const colon = line.indexOf(':');
            if (colon <= 0) continue; // not a header line: skipped, as a tolerant reader does
            name = line.slice(0, colon).trim().toLowerCase();
            value = line.slice(colon + 1);
        }
        flush();
        return new MessageHeaders(fields, data.length);
    }

    /** The first value of `name`, or null. */
    get(name: string): string | null {
        return this.fields.get(name.toLowerCase())?.[0] ?? null;
    }

    all(name: string): readonly string[] {
        return this.fields.get(name.toLowerCase()) ?? [];
    }

    has(name: string): boolean {
        return this.fields.has(name.toLowerCase());
    }

    /** The `<…>` identifiers in `In-Reply-To` and `References`, in order, without duplicates. */
    referencedMessageIds(): string[] {
        const ids = new Set<string>();
        for (const value of [...this.all('in-reply-to'), ...this.all('references')]) {
            for (const match of value.matchAll(/<[^<>\s]+>/g)) ids.add(match[0]);
        }
        return [...ids];
    }
}
