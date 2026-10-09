import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApiDocument } from './document';

/**
 * Writes the contract to `apps/api/openapi.json`. The path is one level above both `src/` and
 * `dist/`, so it resolves the same from either; the package script formats the file afterwards
 * so `format:check` and this writer never disagree.
 */
export const OPENAPI_PATH = join(__dirname, '..', '..', 'openapi.json');

async function main(): Promise<void> {
    const document = await buildOpenApiDocument();
    writeFileSync(OPENAPI_PATH, `${JSON.stringify(document, null, 4)}\n`);
    console.log(`openapi: wrote ${Object.keys(document.paths).length} paths to ${OPENAPI_PATH}`);
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
