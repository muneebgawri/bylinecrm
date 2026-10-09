import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatDay, formatRelative, formatWhen } from './format';

describe('format', () => {
    const now = new Date('2026-10-09T12:00:00Z');

    it('says "—" for nothing rather than a blank or a zero', () => {
        expect(formatDate(null)).toBe('—');
        expect(formatDay(undefined)).toBe('—');
    });

    it('renders a calendar date without inventing a time zone shift', () => {
        expect(formatDay('2026-10-31')).toMatch(/31/);
        expect(formatDay('2026-10-31')).toMatch(/Oct/);
    });

    it('is relative inside a week and absolute beyond it', () => {
        expect(formatRelative('2026-10-09T08:00:00Z', now)).toBe('4 hours ago');
        expect(formatRelative('2026-10-09T11:59:30Z', now)).toBe('just now');
        expect(formatWhen('2026-10-08T12:00:00Z', now)).toBe('yesterday');
        expect(formatWhen('2026-09-01T12:00:00Z', now)).toMatch(/Sep/);
    });

    it('formats bytes for a file list', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(12 * 1024 * 1024 + 400 * 1024)).toBe('12.4 MB');
    });
});
