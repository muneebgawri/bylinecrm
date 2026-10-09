import type { Page } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

/**
 * The checks the route gate runs on every state (doc 48 FR-CRMS-UI-8 and FR-CRMS-UI-12). Each
 * returns findings instead of throwing, so one run reports every problem on every route in one
 * table (reporter.ts) instead of stopping at the first.
 */
export type Check = 'axe' | 'sideways-scroll' | 'touch-target' | 'input-text-size' | 'primary-action';

export interface Finding {
    check: Check;
    detail: string;
}

const WCAG_21_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * An open Radix modal (the ⌘K palette, the record drawer, a dialog) marks everything outside its
 * portal `aria-hidden` and keeps focus inside with its own focus scope. A control left behind in
 * the page is then a focusable element inside an aria-hidden subtree, which axe's
 * `aria-hidden-focus` reports; axe cannot see the focus scope that makes it unreachable. The rule
 * is switched off only while such a layer is open, and stays on for every other state — the same
 * exception, for the same reason, as the design system's gate (packages/ui/gates/a11y.spec.ts).
 */
const RADIX_MODAL_OPEN = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

export async function axe(page: Page): Promise<Finding[]> {
    await injectAxe(page);
    const modalOpen = (await page.locator(RADIX_MODAL_OPEN).count()) > 0;
    const violations = await getViolations(page, 'body', {
        runOnly: { type: 'tag', values: WCAG_21_AA },
        rules: modalOpen ? { 'aria-hidden-focus': { enabled: false } } : {},
    });
    return violations.flatMap((v) =>
        v.nodes.map((node) => ({
            check: 'axe' as const,
            detail: `${v.id}: ${node.target.join(' ')} — ${v.help}`,
        })),
    );
}

/** The page never scrolls sideways (FR-CRMS-UI-12); wide content scrolls inside its own container. */
export async function sidewaysScroll(page: Page): Promise<Finding[]> {
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
    }));
    return scrollWidth > innerWidth
        ? [{ check: 'sideways-scroll', detail: `page is ${scrollWidth}px wide in a ${innerWidth}px viewport` }]
        : [];
}

/**
 * On a phone, every visible control is at least the touch-target token in both directions, and
 * every text field's text is at least the touch-text token (below 16px iOS zooms the page on
 * focus). The sizes are read from the tokens on the page (`--bc-touch-target`, `--bc-touch-text`
 * in packages/ui), so the gate and the components share one definition.
 *
 * Two exemptions, each with its reason:
 * - A link inside running text (an `inline` element whose parent also holds text): WCAG 2.5.8's
 *   "inline" exception — the line height decides its size, and padding it out would break the
 *   sentence.
 * - An element 1px or smaller in either direction: the visually-hidden pattern (`sr-only`), which
 *   is not a touch target at all.
 */
export async function phoneTargets(page: Page): Promise<Finding[]> {
    return page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const target = parseFloat(root.getPropertyValue('--bc-touch-target'));
        const text = parseFloat(root.getPropertyValue('--bc-touch-text'));
        const findings: { check: 'touch-target' | 'input-text-size'; detail: string }[] = [];
        if (!(target > 0) || !(text > 0)) {
            findings.push({
                check: 'touch-target',
                detail: 'the --bc-touch-target / --bc-touch-text tokens are missing',
            });
            return findings;
        }

        const describe = (el: Element) => {
            const id = el.id ? `#${el.id}` : '';
            const label = (el.getAttribute('aria-label') ?? el.textContent ?? '')
                .trim()
                .replace(/\s+/g, ' ')
                .slice(0, 40);
            return `${el.tagName.toLowerCase()}${id}${label ? ` "${label}"` : ''}`;
        };
        const visible = (el: Element) => {
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 1 && rect.height > 1;
        };
        const inlineInText = (el: Element) => {
            if (getComputedStyle(el).display !== 'inline') return false;
            const parent = el.parentElement;
            if (!parent) return false;
            return [...parent.childNodes].some(
                (n) => n !== el && n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
            );
        };

        const interactive = document.querySelectorAll(
            'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], ' +
                '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], ' +
                '[role="switch"], [role="radio"], [role="combobox"], [tabindex]:not([tabindex="-1"])',
        );
        for (const el of interactive) {
            if (!visible(el) || inlineInText(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width + 0.5 < target || rect.height + 0.5 < target) {
                findings.push({
                    check: 'touch-target',
                    detail: `${describe(el)} is ${Math.round(rect.width)}×${Math.round(rect.height)}px (needs ${target}×${target})`,
                });
            }
        }

        const NOT_TEXT = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button', 'reset', 'image']);
        const fields = document.querySelectorAll('input, select, textarea, [contenteditable="true"]');
        for (const el of fields) {
            if (el instanceof HTMLInputElement && NOT_TEXT.has(el.type)) continue;
            if (!visible(el)) continue;
            const size = parseFloat(getComputedStyle(el).fontSize);
            if (size + 0.01 < text) {
                findings.push({
                    check: 'input-text-size',
                    detail: `${describe(el)} has ${size}px text (needs ${text}px)`,
                });
            }
        }
        return findings;
    });
}

/** The page's primary action (`data-primary-action`), when it has one, is not off the side of the screen. */
export async function primaryAction(page: Page): Promise<{ findings: Finding[]; present: boolean }> {
    const result = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-primary-action]')].find((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
        if (!el) return { present: false, off: '' };
        const r = el.getBoundingClientRect();
        const off =
            r.left < 0 || r.right > window.innerWidth
                ? `spans ${Math.round(r.left)}–${Math.round(r.right)}px of ${window.innerWidth}px`
                : '';
        return { present: true, off };
    });
    return {
        present: result.present,
        findings: result.off ? [{ check: 'primary-action', detail: `the primary action ${result.off}` }] : [],
    };
}
