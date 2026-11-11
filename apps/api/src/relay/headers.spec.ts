import { describe, expect, it } from 'vitest';
import { MessageHeaders } from './headers';

describe('MessageHeaders', () => {
    it('reads names case-insensitively, joins folded lines and stops at the body', () => {
        const raw = Buffer.from(
            'From: Ana <ana@example.test>\r\nSubject: Hello\r\n there\r\nX-BylineCRM-Id: abc\r\nReceived: a\r\nReceived: b\r\n\r\nSubject: not a header\r\n',
        );
        const h = MessageHeaders.parse(raw);
        expect(h.get('subject')).toBe('Hello there');
        expect(h.get('SUBJECT')).toBe('Hello there');
        expect(h.has('x-bylinecrm-id')).toBe(true);
        expect(h.all('received')).toEqual(['a', 'b']);
        expect(raw.subarray(h.bodyOffset).toString()).toBe('Subject: not a header\r\n');
    });

    it('accepts bare LF, a missing body and a line without a colon', () => {
        const h = MessageHeaders.parse(Buffer.from('garbage\nSubject: x\nTo: a@b.test'));
        expect(h.get('subject')).toBe('x');
        expect(h.get('to')).toBe('a@b.test');
        expect(h.bodyOffset).toBe(Buffer.byteLength('garbage\nSubject: x\nTo: a@b.test'));
        expect(MessageHeaders.parse(Buffer.alloc(0)).get('subject')).toBeNull();
    });

    it('lists the identifiers a reply names, In-Reply-To first, once each', () => {
        const h = MessageHeaders.parse(Buffer.from('In-Reply-To: <b@x>\r\nReferences: <a@x>\r\n <b@x> <c@x>\r\n\r\n'));
        expect(h.referencedMessageIds()).toEqual(['<b@x>', '<a@x>', '<c@x>']);
        expect(MessageHeaders.parse(Buffer.from('Subject: x\r\n\r\n')).referencedMessageIds()).toEqual([]);
    });
});
