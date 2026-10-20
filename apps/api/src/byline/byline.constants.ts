/** BYL-1: where BylineAI's WEBHOOK connector posts leads, under the tenant prefix (`BYLINE_WEBHOOK_URL`). */
export const BYLINE_INBOUND_PATH = 'inbound/byline';
/** Every BylineAI lead's person source starts so; `byline:<source_key>` when BylineAI names its source. */
export const BYLINE_SOURCE_PREFIX = 'byline';
export const BYLINE_SECRET_MIN = 16;
export const BYLINE_SECRET_MAX = 200;
/** A round-robin list at most this long. */
export const BYLINE_ROUND_ROBIN_MAX = 100;
/** Refused deliveries (unknown workspace, bad signature) per client address per window, before 429. */
export const BYLINE_INBOUND_FAILURE_LIMIT = 30;
export const BYLINE_INBOUND_FAILURE_WINDOW_S = 600;

export function bylineInboundRateKey(clientIp: string): string {
    return `byline-inbound:refused:${clientIp}`;
}

/** The person source a lead is recorded with. */
export function bylineSource(sourceKey: string | undefined): string {
    const key = sourceKey
        ?.toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '_')
        .slice(0, 60);
    return key ? `${BYLINE_SOURCE_PREFIX}:${key}` : BYLINE_SOURCE_PREFIX;
}
