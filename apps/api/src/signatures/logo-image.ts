import { LOGO_WIDTH } from '@bylinecrm/shared';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * A logo upload as the PNG every signature links to (#193): read as PNG or JPEG — by its bytes, not its
 * declared type — scaled down to at most `LOGO_WIDTH` wide by averaging (never up), written as PNG.
 * Pure JavaScript with permissive licences (`pngjs` MIT, `jpeg-js` BSD-3-Clause); an image's size is read
 * from its header and refused above `LOGO_MAX_PIXELS` before anything is decoded, so a small file cannot
 * unpack into a huge bitmap.
 */

/** Width × height an upload may decode to: 25 megapixels. */
export const LOGO_MAX_PIXELS = 25_000_000;

export class UnreadableImage extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnreadableImage';
    }
}

interface Bitmap {
    width: number;
    height: number;
    /** RGBA, 8 bits a channel, row by row. */
    data: Buffer | Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function logoPng(bytes: Buffer): { data: Buffer; width: number; height: number } {
    const bitmap = decode(bytes);
    const scaled = bitmap.width > LOGO_WIDTH ? downscale(bitmap, LOGO_WIDTH) : bitmap;
    const png = new PNG({ width: scaled.width, height: scaled.height });
    png.data = Buffer.from(scaled.data);
    return { data: PNG.sync.write(png), width: scaled.width, height: scaled.height };
}

function decode(bytes: Buffer): Bitmap {
    if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        // IHDR is the first chunk: width and height at bytes 16 and 20.
        if (bytes.length < 24) throw new UnreadableImage('the PNG is cut short');
        assertSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
        try {
            return PNG.sync.read(bytes);
        } catch {
            throw new UnreadableImage('the PNG cannot be read');
        }
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        try {
            return jpeg.decode(bytes, {
                useTArray: true,
                formatAsRGBA: true,
                maxResolutionInMP: LOGO_MAX_PIXELS / 1_000_000,
                maxMemoryUsageInMB: 256,
            });
        } catch {
            throw new UnreadableImage('the JPEG cannot be read');
        }
    }
    throw new UnreadableImage('a logo is a PNG or a JPEG');
}

function assertSize(width: number, height: number): void {
    if (width === 0 || height === 0 || width * height > LOGO_MAX_PIXELS) {
        throw new UnreadableImage(`an image is at most ${LOGO_MAX_PIXELS / 1_000_000} megapixels`);
    }
}

/**
 * Scales down by area averaging: each target pixel is the mean of the source pixels it covers, colour
 * weighted by alpha so transparent edges do not darken.
 */
function downscale(source: Bitmap, width: number): Bitmap {
    const height = Math.max(1, Math.round((source.height * width) / source.width));
    const out = Buffer.alloc(width * height * 4);
    const xRatio = source.width / width;
    const yRatio = source.height / height;
    for (let y = 0; y < height; y += 1) {
        const y0 = Math.floor(y * yRatio);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
        for (let x = 0; x < width; x += 1) {
            const x0 = Math.floor(x * xRatio);
            const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;
            for (let sy = y0; sy < y1; sy += 1) {
                for (let sx = x0; sx < x1; sx += 1) {
                    const i = (sy * source.width + sx) * 4;
                    const alpha = source.data[i + 3]!;
                    r += source.data[i]! * alpha;
                    g += source.data[i + 1]! * alpha;
                    b += source.data[i + 2]! * alpha;
                    a += alpha;
                    n += 1;
                }
            }
            const o = (y * width + x) * 4;
            out[o] = a ? Math.round(r / a) : 0;
            out[o + 1] = a ? Math.round(g / a) : 0;
            out[o + 2] = a ? Math.round(b / a) : 0;
            out[o + 3] = Math.round(a / n);
        }
    }
    return { width, height, data: out };
}
