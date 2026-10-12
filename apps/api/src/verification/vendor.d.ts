/**
 * `disposable-email-domains` (MIT) ships its list as JSON with no types: every domain known to hand
 * out throwaway addresses, lower case, one per entry.
 */
declare module 'disposable-email-domains' {
    const domains: readonly string[];
    export default domains;
}
