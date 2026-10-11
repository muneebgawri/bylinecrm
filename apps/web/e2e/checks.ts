import type { Page } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

/**
 * The checks the route gate runs on every state (doc 48 FR-CRMS-UI-8 and FR-CRMS-UI-12). Each
 * returns findings instead of throwing, so one run reports every problem on every route in one
 * table (reporter.ts) instead of stopping at the first.
 */
export type Check =
    | 'axe'
    | 'sideways-scroll'
    | 'touch-target'
    | 'top-bar-spill'
    | 'input-text-size'
    | 'primary-action'
    | 'phone-table'
    | 'bottom-bar'
    | 'above-fold';

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
 * - An element nobody can touch: `aria-hidden="true"` with `pointer-events: none`. Radix renders one
 *   beside every checkbox and switch — a native input that mirrors the control for form submission —
 *   so it is neither seen by assistive technology nor hit by a finger; the control beside it is the
 *   target, and is checked.
 *
 * `scope` narrows the check to one element (the open dialog, PRIMARY_DIALOG below); the findings
 * then say where they were found.
 */
export async function phoneTargets(page: Page, scope?: string): Promise<Finding[]> {
    const findings = await page.evaluate((scopeSelector) => {
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

        const scopeEl = scopeSelector ? [...document.querySelectorAll(scopeSelector)].pop() : document;
        if (!scopeEl) {
            findings.push({ check: 'touch-target', detail: `nothing matches ${scopeSelector} to check inside` });
            return findings;
        }
        const interactive = scopeEl.querySelectorAll(
            'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], ' +
                '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], ' +
                '[role="switch"], [role="radio"], [role="combobox"], [tabindex]:not([tabindex="-1"])',
        );
        const untouchable = (el: Element) =>
            el.getAttribute('aria-hidden') === 'true' && getComputedStyle(el).pointerEvents === 'none';
        for (const el of interactive) {
            if (!visible(el) || inlineInText(el) || untouchable(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width + 0.5 < target || rect.height + 0.5 < target) {
                findings.push({
                    check: 'touch-target',
                    detail: `${describe(el)} is ${Math.round(rect.width)}×${Math.round(rect.height)}px (needs ${target}×${target})`,
                });
            }
        }

        const NOT_TEXT = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button', 'reset', 'image']);
        const fields = scopeEl.querySelectorAll('input, select, textarea, [contenteditable="true"]');
        for (const el of fields) {
            if (el instanceof HTMLInputElement && NOT_TEXT.has(el.type)) continue;
            if (!visible(el) || untouchable(el)) continue;
            const size = parseFloat(getComputedStyle(el).fontSize);
            if (size + 0.01 < text) {
                findings.push({
                    check: 'input-text-size',
                    detail: `${describe(el)} has ${size}px text (needs ${text}px)`,
                });
            }
        }
        return findings;
    }, scope);
    return scope ? findings.map((f) => ({ ...f, detail: `in ${scope}: ${f.detail}` })) : findings;
}

/**
 * The element a page marks as opening its main dialog or sheet (`data-primary-dialog`, on the
 * trigger — usually the page's primary action). On a phone the gate opens it and checks the
 * controls inside (touch targets, field text size), so a form in a dialog is held to the same
 * rules as the page (FR-CRMS-UI-12).
 */
export const PRIMARY_DIALOG_TRIGGER = '[data-primary-dialog]';
/** The open dialog or sheet: every one in the design system is a Radix dialog. */
export const OPEN_DIALOG = '[role="dialog"]';
/**
 * Popups a page offers on a phone, opened and checked like the dialog: the first menu trigger in the
 * page's main content (row actions — the phone's way to reorder or delete, since drag handles are
 * hidden there), and the first picker inside the open dialog. Their items are touch targets too.
 */
export const MENU_TRIGGER = 'main [aria-haspopup="menu"]';
export const OPEN_MENU = '[role="menu"]';
/** A select's trigger is a button; a search-as-you-type picker (an input) opens only after typing. */
export const PICKER_TRIGGER = '[role="dialog"] button[role="combobox"]';
export const OPEN_LISTBOX = '[role="listbox"]';

/**
 * On a phone, records are stacked cards, never a table (FR-CRMS-UI-12): a table that scrolls
 * sideways inside its card passes the page-scroll check but is still unusable on a 375px screen.
 * Two findings:
 * - any visible `table`, `[role=table]` or `[role=grid]`;
 * - any visible element that scrolls sideways (`overflow-x` auto or scroll, content wider than the
 *   box) and holds tabular content (`table`, `[role=row]`, `[role=table]`, `[role=grid]`) — a
 *   hand-built grid of rows is a table whatever its tags say.
 * A horizontally scrolling row of chips or tabs (no tabular content) is allowed: that is how the
 * view chips and stage chips are meant to work on a phone.
 */
export async function phoneTables(page: Page): Promise<Finding[]> {
    return page.evaluate(() => {
        const TABULAR = 'table, [role="table"], [role="grid"]';
        const describe = (el: Element) => {
            const id = el.id ? `#${el.id}` : '';
            const label = (
                el.getAttribute('aria-label') ??
                el.querySelector('th, [role="columnheader"]')?.textContent ??
                ''
            )
                .trim()
                .replace(/\s+/g, ' ')
                .slice(0, 40);
            const role = el.getAttribute('role');
            return `${el.tagName.toLowerCase()}${id}${role ? `[role=${role}]` : ''}${label ? ` "${label}"` : ''}`;
        };
        const visible = (el: Element) => {
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 1 && rect.height > 1;
        };
        const findings: { check: 'phone-table'; detail: string }[] = [];
        const reported = new Set<Element>();
        for (const el of document.querySelectorAll(TABULAR)) {
            if (!visible(el)) continue;
            reported.add(el);
            findings.push({ check: 'phone-table', detail: `${describe(el)} is a table on a phone` });
        }
        for (const el of document.querySelectorAll('body *')) {
            const overflowX = getComputedStyle(el).overflowX;
            if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
            if (el.scrollWidth <= el.clientWidth + 1 || !visible(el)) continue;
            const tabular = el.querySelector(`${TABULAR}, [role="row"]`);
            if (!tabular || reported.has(tabular)) continue;
            findings.push({
                check: 'phone-table',
                detail: `${describe(el)} scrolls sideways (${el.scrollWidth}px in ${el.clientWidth}px) holding rows`,
            });
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

/**
 * The height of the smallest phone the product is held to (iPhone SE, 375×667). The gate's phone
 * viewport is taller; what a page promises "above the fold" is checked against this line instead,
 * so a layout that only works on tall phones fails (FR-CRMS-UI-12).
 */
export const PHONE_FOLD_PX = 667;

/**
 * A record page on a phone keeps its actions in a bar fixed to the bottom of the screen
 * (`data-bottom-bar`), not at the top of the page where they scroll away (FR-CRMS-UI-12). The bar
 * must be visible and inside the viewport with the page scrolled to the top.
 */
export async function phoneBottomBar(page: Page): Promise<Finding[]> {
    const result = await page.evaluate(() => {
        const bars = [...document.querySelectorAll('[data-bottom-bar]')].filter((el) => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
        });
        const bar = bars[0];
        if (!bar) return 'no visible [data-bottom-bar] on a record page';
        const rect = bar.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight + 0.5) {
            return `the bottom bar spans ${Math.round(rect.top)}–${Math.round(rect.bottom)}px of a ${window.innerHeight}px viewport`;
        }
        return '';
    });
    return result ? [{ check: 'bottom-bar', detail: result }] : [];
}

/**
 * The first element matching `selector` that is on screen horizontally ends above PHONE_FOLD_PX
 * with the page scrolled to the top: on the deals board, the first card of the stage shown is on
 * screen without scrolling past the page's chrome.
 */
export async function aboveFold(page: Page, selector: string): Promise<Finding[]> {
    const result = await page.evaluate(
        ([sel, fold]) => {
            // On screen horizontally too: a phone's board pages one stage per screen, and a card
            // in a stage scrolled off to the side is not "above the fold" for anyone.
            const el = [...document.querySelectorAll(sel)].find((e) => {
                const r = e.getBoundingClientRect();
                return r.width > 1 && r.height > 1 && r.left >= 0 && r.right <= window.innerWidth + 0.5;
            });
            if (!el) return `nothing on screen matches ${sel}`;
            const bottom = el.getBoundingClientRect().bottom;
            return bottom > fold ? `the first ${sel} ends at ${Math.round(bottom)}px, below the ${fold}px fold` : '';
        },
        [selector, PHONE_FOLD_PX] as const,
    );
    return result ? [{ check: 'above-fold', detail: result }] : [];
}

/**
 * On a phone, nothing in the app's top bar lets its content spill past its own box: a breadcrumb
 * that does not truncate runs underneath the search and notification buttons beside it (found
 * walking P1-UI-11 at 375px: "Settings / Cu[search]elds"). The page-scroll and touch-target checks
 * cannot see this — nothing scrolls and every control is still 44px. A box that clips its overflow
 * (`overflow` not visible) is fine; that is what truncation is.
 */
export async function phoneTopBarSpill(page: Page): Promise<Finding[]> {
    return page.evaluate(() => {
        const bar = document.querySelector('header');
        if (!bar) return [];
        const findings: { check: 'top-bar-spill'; detail: string }[] = [];
        for (const el of bar.querySelectorAll('*')) {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (style.overflowX !== 'visible') continue;
            if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth === 0) continue;
            const label = (el.getAttribute('aria-label') ?? el.textContent ?? '')
                .trim()
                .replace(/\s+/g, ' ')
                .slice(0, 40);
            findings.push({
                check: 'top-bar-spill',
                detail: `${el.tagName.toLowerCase()} "${label}" holds ${el.scrollWidth}px of content in ${el.clientWidth}px`,
            });
        }
        return findings;
    });
}
