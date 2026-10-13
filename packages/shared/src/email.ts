/**
 * The one rule for an email address (#180). Every parser of an address — suppression, unsubscribe,
 * outreach exclusions, the Twenty importer, the settings pages — goes through `normaliseEmail`, so
 * an address one part accepts is never refused by another.
 */

/** RFC 5321's limit on an address's length. */
export const EMAIL_ADDRESS_MAX = 254;

const ADDRESS = /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** The stored form of an address — trimmed, lower case — or `null` when it is not an address. */
export function normaliseEmail(raw: string): string | null {
    const value = raw.trim().toLowerCase();
    if (value.length === 0 || value.length > EMAIL_ADDRESS_MAX) return null;
    return ADDRESS.test(value) ? value : null;
}
