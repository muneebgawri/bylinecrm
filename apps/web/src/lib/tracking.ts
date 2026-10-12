import type { TrackingCountsView } from '../api/types';

/**
 * Tracking counts as a person reads them (P3-4, FR-CRMS-8): "7 clicks (5 unique) · 12 opens
 * (indicative)". Opens are labelled indicative wherever they are shown — mail clients prefetch
 * images — and the wording is here once so no screen forgets the label.
 */
export function trackingText(counts: TrackingCountsView): string {
    const clicks =
        counts.clicks === 0
            ? 'No clicks'
            : `${counts.clicks.toLocaleString('en-US')} ${counts.clicks === 1 ? 'click' : 'clicks'}${
                  counts.uniqueClicks > 0 && counts.uniqueClicks !== counts.clicks
                      ? ` (${counts.uniqueClicks.toLocaleString('en-US')} unique)`
                      : ''
              }`;
    const opens = `${counts.opens.toLocaleString('en-US')} ${counts.opens === 1 ? 'open' : 'opens'} (indicative)`;
    return `${clicks} · ${opens}`;
}

/** Whether anything was counted at all. */
export function hasTracking(counts: TrackingCountsView): boolean {
    return counts.clicks > 0 || counts.opens > 0;
}
