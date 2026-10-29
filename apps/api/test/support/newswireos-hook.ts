import { createHmac } from 'node:crypto';
import { NEWSWIREOS_TIMED_SIGNATURE_HEADER, NEWSWIREOS_TIMESTAMP_HEADER } from '../../src/invoices/invoices.constants';

/** The headers NewswireOS signs a delivery with (INV-2): when, and the signature over `${when}.${raw}`. */
export function newswireosSignature(raw: string, secret: string, at: Date = new Date()): Record<string, string> {
    const timestamp = String(Math.floor(at.getTime() / 1000));
    const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    return { [NEWSWIREOS_TIMESTAMP_HEADER]: timestamp, [NEWSWIREOS_TIMED_SIGNATURE_HEADER]: `sha256=${signature}` };
}
