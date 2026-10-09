import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from './csv';

describe('csv', () => {
    it('quotes a cell holding a comma, a quote or a line break, doubling quotes', () => {
        expect(csvCell('plain')).toBe('plain');
        expect(csvCell('a, b')).toBe('"a, b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('two\nlines')).toBe('"two\nlines"');
    });

    it('neutralises a cell that a spreadsheet would run as a formula', () => {
        expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
        expect(csvCell('+1')).toBe("'+1");
        expect(csvCell('-1')).toBe("'-1");
        expect(csvCell('@cmd')).toBe("'@cmd");
        expect(csvCell('\tx')).toBe("'\tx");
        // A neutralised cell that also needs quoting gets both.
        expect(csvCell('=1,2')).toBe('"\'=1,2"');
    });

    it('prints nothing for null, ISO for dates, digits for bigints, JSON for structures', () => {
        expect(csvCell(null)).toBe('');
        expect(csvCell(undefined)).toBe('');
        expect(csvCell(new Date('2026-10-09T00:00:00Z'))).toBe('2026-10-09T00:00:00.000Z');
        expect(csvCell(120050n)).toBe('120050');
        expect(csvCell({ primary: 'a@b.c' })).toBe('"{""primary"":""a@b.c""}"');
    });

    it('ends a row with CRLF', () => {
        expect(csvRow(['a', 1, null])).toBe('a,1,\r\n');
    });
});
