// Makes the social icons signatures link (#193): `apps/api/assets/social-icons/<network>.png`, 40 px square
// (shown at 20 px, so sharp on a high-density screen) — each network's glyph from Tabler Icons (MIT), white
// on the network's colour in a rounded square. Run once after changing an icon, and commit the PNGs; the API
// only serves them. A changed icon gets a new served path (`SOCIAL_ICON_PATH`'s version), because mail clients
// cache the old one for good.
//
//   node scripts/social-icons.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Playwright's Chromium is the web app's (its route gate); nothing new is installed for this.
const { chromium } = createRequire(join(root, 'apps/web/package.json'))('@playwright/test');

const NETWORKS = {
    linkedin: { glyph: 'brand-linkedin', colour: '#0A66C2' },
    x: { glyph: 'brand-x', colour: '#000000' },
    facebook: { glyph: 'brand-facebook', colour: '#1877F2' },
    instagram: { glyph: 'brand-instagram', colour: '#E4405F' },
    youtube: { glyph: 'brand-youtube', colour: '#FF0000' },
    telegram: { glyph: 'brand-telegram', colour: '#26A5E4' },
};
const SIZE = 40;
const out = join(root, 'apps/api/assets/social-icons');
mkdirSync(out, { recursive: true });

// The installed Chrome when Playwright's own browser has not been downloaded.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });
for (const [network, { glyph, colour }] of Object.entries(NETWORKS)) {
    const svg = readFileSync(join(root, 'node_modules/@tabler/icons/icons/outline', `${glyph}.svg`), 'utf8')
        .replace('stroke="currentColor"', 'stroke="#ffffff"')
        .replace(/width="24"/, 'width="26"')
        .replace(/height="24"/, 'height="26"');
    await page.setContent(
        `<html><body style="margin:0;background:transparent">` +
            `<div style="width:${SIZE}px;height:${SIZE}px;border-radius:9px;background:${colour};display:flex;align-items:center;justify-content:center">${svg}</div>` +
            `</body></html>`,
    );
    await page.screenshot({
        path: join(out, `${network}.png`),
        omitBackground: true,
        clip: { x: 0, y: 0, width: SIZE, height: SIZE },
    });
    console.log(`${network}.png`);
}
await browser.close();
