import { createReadStream } from 'node:fs';

/**
 * RFC 4180 CSV, read as a stream (BIGIN-1: a Bigin backup export). A quoted cell may hold commas, doubled quotes
 * and line breaks — a note's content runs to many lines and megabytes — so a row is never a line. The first row
 * names the columns; a byte-order mark before it is dropped. No dependency reads CSV here, and a file of 170,000
 * rows is read without holding it whole.
 */
export class CsvParser {
    private cell = '';
    private row: string[] = [];
    private quoted = false;
    /** Inside quotes, a `"` was just read: a second one is a literal quote, anything else ends the quotes. */
    private quoteSeen = false;
    /** A `\r` ended the last row: a `\n` straight after it belongs to the same line break. */
    private afterCr = false;
    private started = false;

    /** Feeds the next piece of text; returns the rows it completed. */
    push(text: string): string[][] {
        const rows: string[][] = [];
        let i = 0;
        if (!this.started && text.length > 0) {
            this.started = true;
            if (text.charCodeAt(0) === 0xfeff) i = 1;
        }
        for (; i < text.length; i++) {
            const ch = text[i]!;
            if (this.afterCr) {
                this.afterCr = false;
                if (ch === '\n') continue;
            }
            if (this.quoted) {
                if (this.quoteSeen) {
                    this.quoteSeen = false;
                    if (ch === '"') {
                        this.cell += '"';
                        continue;
                    }
                    this.quoted = false;
                    // Falls through: the character after the closing quote is read as unquoted.
                } else if (ch === '"') {
                    this.quoteSeen = true;
                    continue;
                } else {
                    // Runs of plain text are taken at once: a megabyte-long note is not read a character at a time.
                    const end = text.indexOf('"', i);
                    const stop = end === -1 ? text.length : end;
                    this.cell += text.slice(i, stop);
                    i = stop - 1;
                    continue;
                }
            }
            if (ch === '"' && this.cell === '') {
                this.quoted = true;
            } else if (ch === ',') {
                this.row.push(this.cell);
                this.cell = '';
            } else if (ch === '\n' || ch === '\r') {
                this.afterCr = ch === '\r';
                rows.push(this.endRow());
            } else {
                this.cell += ch;
            }
        }
        return rows;
    }

    /** The end of the input: the last row, when it had no line break after it. */
    end(): string[][] {
        if (this.quoted && !this.quoteSeen) throw new Error('the CSV ends inside a quoted cell');
        this.quoted = false;
        this.quoteSeen = false;
        return this.cell !== '' || this.row.length > 0 ? [this.endRow()] : [];
    }

    private endRow(): string[] {
        this.row.push(this.cell);
        const row = this.row;
        this.row = [];
        this.cell = '';
        return row;
    }
}

/** Rows as objects keyed by the header row; a blank line is passed over. */
function* keyed(header: string[] | null, rows: string[][], setHeader: (h: string[]) => void) {
    for (const row of rows) {
        if (row.length === 1 && row[0] === '') continue;
        if (!header) {
            header = row;
            setHeader(row);
            continue;
        }
        const out: Record<string, string> = {};
        // Bigin repeats a few labels (Events' `Check-In Address`): the first column of a name is the one kept.
        for (let c = 0; c < header.length; c++) if (!(header[c]! in out)) out[header[c]!] = row[c] ?? '';
        yield out;
    }
}

/** A whole CSV text as rows keyed by its header. */
export function parseCsv(text: string): Record<string, string>[] {
    const parser = new CsvParser();
    let header: string[] | null = null;
    const set = (h: string[]) => (header = h);
    return [...keyed(header, parser.push(text), set), ...keyed(header, parser.end(), set)];
}

/** A CSV file's rows keyed by its header, as they are read. */
export async function* readCsvFile(path: string): AsyncGenerator<Record<string, string>> {
    const parser = new CsvParser();
    let header: string[] | null = null;
    const set = (h: string[]) => (header = h);
    for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
        yield* keyed(header, parser.push(chunk as string), set);
    }
    yield* keyed(header, parser.end(), set);
}
