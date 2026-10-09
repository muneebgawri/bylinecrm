import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PIPELINE_NAME, DEFAULT_STAGES } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';

/**
 * The migration that introduced pipelines seeded existing workspaces in SQL; new workspaces are
 * seeded in TypeScript from DEFAULT_STAGES. Two writers of one list is a divergence waiting to
 * happen, so this holds the SQL to the constant: a change to one without the other fails here.
 */
describe('the default stages', () => {
    const sql = readFileSync(
        resolve(__dirname, '../../prisma/migrations/20261009000700_pipelines/migration.sql'),
        'utf8',
    );

    it('are the same list in the migration as in @bylinecrm/shared, in the same order', () => {
        const rows = [...sql.matchAll(/\('([^']+)',\s*(\d+),\s*(\d+),\s*'(\w+)',\s*'(\w+)'\)/g)].map((m) => ({
            name: m[1],
            position: Number(m[2]),
            probability: Number(m[3]),
            kind: m[4],
            colour: m[5],
        }));
        expect(rows).toEqual(
            DEFAULT_STAGES.map((stage, index) => ({
                name: stage.name,
                position: index + 1,
                probability: stage.probability,
                kind: stage.kind,
                colour: stage.colour,
            })),
        );
    });

    it('belong to the pipeline of the same name', () => {
        expect(sql).toContain(`'${DEFAULT_PIPELINE_NAME}'`);
    });

    it('start with an open stage and contain exactly one won and one lost stage', () => {
        expect(DEFAULT_STAGES[0]?.kind).toBe('open');
        expect(DEFAULT_STAGES.filter((s) => s.kind === 'won')).toHaveLength(1);
        expect(DEFAULT_STAGES.filter((s) => s.kind === 'lost')).toHaveLength(1);
    });
});
