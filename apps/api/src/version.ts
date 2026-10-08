import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The API's version, read from its package.json. The file sits one level above both `src/` and
 * `dist/`, so the same relative path is right in development and in the built output.
 */
export const VERSION: string = (
    JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
        version: string;
    }
).version;
