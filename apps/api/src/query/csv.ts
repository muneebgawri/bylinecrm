/**
 * One CSV writer (RFC 4180): comma-separated, CRLF rows, a field quoted when it holds a comma, a
 * quote or a line break, quotes doubled. The export streams through `csvRow` one row at a time
 * and never holds the file.
 *
 * Formula injection: a spreadsheet executes a cell that starts with `=`, `+`, `-`, `@` (and the
 * tab/CR variants). A value a stranger typed into a record must never become a formula on an
 * analyst's machine, so such a cell is prefixed with a single quote — the spreadsheet shows it as
 * text and the data is intact apart from the visible quote. One rule, applied to every cell.
 */

/** The byte-order mark Excel needs to read UTF-8 as UTF-8. */
export const CSV_BOM = '﻿';

const FORMULA_LEADERS = ['=', '+', '-', '@', '\t', '\r'];

export function csvCell(value: unknown): string {
    const text = textOf(value);
    const safe = FORMULA_LEADERS.some((c) => text.startsWith(c)) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvRow(values: readonly unknown[]): string {
    return `${values.map(csvCell).join(',')}\r\n`;
}

/** How a value prints: nothing for null, ISO for dates, JSON for structures, the string otherwise. */
function textOf(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}
