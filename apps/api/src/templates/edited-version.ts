import { ValidationFailed } from '../infra/errors/api-errors';

/** `3`, `"3"` or `W/"3"` — an `If-Match` naming a template version. */
const IF_MATCH = /^(?:W\/)?"?([1-9][0-9]{0,9})"?$/;

/**
 * The version a PATCH edited: the body's `version`, or the `If-Match` header's (P2-4). One of them
 * is required, and when both are given they must agree — a PATCH that names no version could
 * overwrite someone else's edit without knowing it.
 */
export function editedVersion(bodyVersion: number | undefined, ifMatch: string | undefined): number {
    let headerVersion: number | undefined;
    if (ifMatch !== undefined && ifMatch.trim() !== '') {
        const match = IF_MATCH.exec(ifMatch.trim());
        if (!match) {
            throw new ValidationFailed('If-Match must name a template version', [
                { path: 'version', message: 'If-Match must be a version number, e.g. "3"' },
            ]);
        }
        headerVersion = Number(match[1]);
    }
    if (bodyVersion !== undefined && headerVersion !== undefined && bodyVersion !== headerVersion) {
        throw new ValidationFailed('the body and If-Match name different versions', [
            { path: 'version', message: `the body says ${bodyVersion}, If-Match says ${headerVersion}` },
        ]);
    }
    const version = bodyVersion ?? headerVersion;
    if (version === undefined) {
        throw new ValidationFailed('name the version you edited', [
            { path: 'version', message: 'send the version you edited, as `version` or as If-Match' },
        ]);
    }
    return version;
}
