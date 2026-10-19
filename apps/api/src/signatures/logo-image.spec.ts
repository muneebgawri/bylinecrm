import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { logoPng } from './logo-image';

/** A `width`×`height` image whose `box` is filled with `ink` and the rest with `paper`. */
function picture(
    width: number,
    height: number,
    box: { x: number; y: number; w: number; h: number },
    ink: number[],
    paper: number[],
): Buffer {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
            data.set(inside ? ink : paper, (y * width + x) * 4);
        }
    }
    return data;
}
const png = (data: Buffer, width: number, height: number) => {
    const image = new PNG({ width, height });
    image.data = data;
    return PNG.sync.write(image);
};
const sizeOf = (bytes: Buffer) => {
    const image = PNG.sync.read(bytes);
    return { width: image.width, height: image.height };
};

describe('#193 logoPng trims the empty border, so the logo sits flush in a signature', () => {
    it('cuts a transparent margin away', () => {
        const bytes = png(picture(100, 40, { x: 10, y: 5, w: 80, h: 30 }, [55, 6, 101, 255], [0, 0, 0, 0]), 100, 40);
        const out = logoPng(bytes);
        expect(out).toMatchObject({ width: 80, height: 30 });
        expect(sizeOf(out.data)).toEqual({ width: 80, height: 30 });
    });

    it('cuts a plain background around an opaque logo (a JPEG on white)', () => {
        const rgba = picture(100, 40, { x: 20, y: 10, w: 60, h: 20 }, [55, 6, 101, 255], [255, 255, 255, 255]);
        const bytes = Buffer.from(jpeg.encode({ width: 100, height: 40, data: rgba }, 95).data);
        const out = logoPng(bytes);
        // JPEG blurs the edge by a pixel or two; the margin itself is gone.
        expect(out.width).toBeGreaterThanOrEqual(60);
        expect(out.width).toBeLessThanOrEqual(64);
        expect(out.height).toBeGreaterThanOrEqual(20);
        expect(out.height).toBeLessThanOrEqual(24);
    });

    it('trims before it scales, and leaves a logo with no margin as it is', () => {
        const wide = png(
            picture(900, 120, { x: 50, y: 20, w: 800, h: 80 }, [245, 134, 52, 255], [0, 0, 0, 0]),
            900,
            120,
        );
        expect(logoPng(wide)).toMatchObject({ width: 360, height: 36 });
        const full = png(picture(200, 50, { x: 0, y: 0, w: 200, h: 50 }, [245, 134, 52, 255], [0, 0, 0, 0]), 200, 50);
        expect(logoPng(full)).toMatchObject({ width: 200, height: 50 });
    });

    it('keeps an image that is all background whole, rather than cutting it to nothing', () => {
        const blank = png(picture(50, 20, { x: 0, y: 0, w: 0, h: 0 }, [0, 0, 0, 0], [0, 0, 0, 0]), 50, 20);
        expect(logoPng(blank)).toMatchObject({ width: 50, height: 20 });
    });
});
