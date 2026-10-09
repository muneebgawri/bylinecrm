import { PassThrough, type Readable } from 'node:stream';
import { BadRequestException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_ALLOWLIST } from '@bylinecrm/shared';
import busboy from 'busboy';
import type { Request } from 'express';

/** The multipart field an upload travels in. */
export const UPLOAD_FIELD = 'file';

export interface UploadedFile {
    name: string;
    mime: string;
    /** The file's bytes as they arrive; consume it before the request ends. */
    body: Readable;
}

/**
 * Reads the one file of a multipart request as a stream, so the bytes go to storage without
 * ever being held in memory. The size cap is the parser's own limit: when it trips, the stream
 * ends in a `413` and whatever storage had taken is discarded by the caller. The content type is
 * what the client declared — the allowlist is a policy on that declaration, not a sniff of the
 * bytes; a sniff would be a later addition in one place, here.
 */
export function readUpload(req: Request): Promise<UploadedFile> {
    return new Promise((resolve, reject) => {
        let parser: busboy.Busboy;
        try {
            parser = busboy({ headers: req.headers, limits: { files: 1, fileSize: ATTACHMENT_MAX_BYTES } });
        } catch {
            reject(new BadRequestException('expected a multipart/form-data body'));
            return;
        }
        let found = false;
        parser.on('file', (field, stream, info) => {
            if (field !== UPLOAD_FIELD) {
                stream.resume();
                return;
            }
            found = true;
            const mime = info.mimeType.toLowerCase();
            if (!(ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(mime)) {
                stream.resume();
                reject(new UnsupportedMediaTypeException(`content type ${mime} is not accepted`));
                return;
            }
            const body = new PassThrough();
            stream.on('limit', () =>
                body.destroy(new PayloadTooLargeException(`a file is at most ${ATTACHMENT_MAX_BYTES} bytes`)),
            );
            stream.on('error', (error) => body.destroy(error));
            stream.pipe(body);
            resolve({ name: safeName(info.filename), mime, body });
        });
        parser.on('error', (error: Error) => reject(new BadRequestException(`malformed upload: ${error.message}`)));
        parser.on('close', () => {
            if (!found) reject(new BadRequestException(`multipart field "${UPLOAD_FIELD}" is required`));
        });
        req.pipe(parser);
    });
}

/** A file name as a header can carry it: no path, no control characters, never empty. */
function safeName(raw: string | undefined): string {
    const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
    const clean = [...base]
        .filter((ch) => {
            const code = ch.charCodeAt(0);
            return code > 0x1f && code !== 0x7f && ch !== '"';
        })
        .join('')
        .trim();
    return clean.slice(0, 255) || 'file';
}
