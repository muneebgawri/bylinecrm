// #69: the FR traceability check. Run with `node --test scripts/fr-traceability.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namedIds, parseScope, traceability } from './fr-traceability.mjs';

const scope = parseScope(`
# comment
[phase 1: complete]
FR-CRMS-9
FR-CRMS-UI-1
[phase 3: in progress]
FR-CRMS-5
FR-CRMS-8
[deferred]
FR-CRMS-UI-11   # later
`);
const file = (text) => ({ path: 'x.spec.ts', text });

test('#69 reads ids only from describe/it/test titles, not comments or code', () => {
    const named = namedIds([
        file(
            `// FR-CRMS-8 in a comment\nconst x = 'FR-CRMS-5';\ndescribe('FR-CRMS-9: stage rules', () => { it("FR-CRMS-UI-1 lists", () => {}); });`,
        ),
    ]);
    assert.deepEqual([...named].sort(), ['FR-CRMS-9', 'FR-CRMS-UI-1']);
});

test('#69 a complete phase with every id named passes; an in-progress gap is reported, not failed', () => {
    const { lines, failures } = traceability(scope, [
        file(`describe('FR-CRMS-9 and FR-CRMS-UI-1', () => {}); it('FR-CRMS-5', () => {});`),
    ]);
    assert.deepEqual(failures, []);
    assert.ok(lines.includes('phase 1 (complete): 2/2 named'));
    assert.ok(lines.includes('  not yet: FR-CRMS-8'));
});

test('#69 a complete phase with an unnamed id fails, naming it', () => {
    const { failures } = traceability(scope, [file(`describe('FR-CRMS-9', () => {});`)]);
    assert.deepEqual(failures, ['FR-CRMS-UI-1']);
});

test('#69 an id named in a title but absent from the scope fails: the scope is the one list', () => {
    const { failures } = traceability(scope, [file(`describe('FR-CRMS-9 FR-CRMS-UI-1 FR-CRMS-99', () => {});`)]);
    assert.deepEqual(failures, ['FR-CRMS-99']);
});

test('#69 the scope refuses a phase without a state, a duplicate id and a stray line', () => {
    assert.throws(() => parseScope('[phase 1]\nFR-CRMS-1'), /needs a state/);
    assert.throws(() => parseScope('[phase 1: complete]\nFR-CRMS-1\nFR-CRMS-1'), /listed twice/);
    assert.throws(() => parseScope('FR-CRMS-1'), /outside any/);
});
