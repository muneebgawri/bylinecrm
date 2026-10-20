import type { BiginStageMatch, StageKind } from '@bylinecrm/shared';
import { ApiException } from '../infra/errors/api-errors';

/** A stage of the default pipeline, as the importer chooses among them (in pipeline order). */
export interface PipelineStageRef {
    id: string;
    name: string;
    kind: StageKind;
}

export interface StageChoice {
    id: string;
    kind: StageKind;
    match: BiginStageMatch;
    /** Bigin's stage had no stage here by mapping, name or heuristic: the deal went to the first open stage. */
    unknown: boolean;
}

/** Bigin stage names compare with case and outer spaces aside. */
export const biginStageKey = (raw: string): string => raw.trim().toLowerCase();

/** The workspace's mapping, keyed by `biginStageKey`. */
export function biginStageIndex(rows: readonly { biginStage: string; stageId: string }[]): Map<string, string> {
    return new Map(rows.map((row) => [biginStageKey(row.biginStage), row.stageId]));
}

/**
 * Where a deal in Bigin stage `raw` lands in the default pipeline: the workspace's explicit mapping first,
 * then a stage of the same name (case aside), then a Bigin stage naming won or lost to the pipeline's won or
 * lost stage, else the first open stage — that last is the only `unknown` one. A deal with no stage goes to the
 * first open stage without being unknown. Stages are never made here.
 */
export function chooseStage(
    stages: readonly PipelineStageRef[],
    mapping: ReadonlyMap<string, string>,
    raw: string | null,
): StageChoice {
    const open = stages.find((s) => s.kind === 'open');
    if (!open) throw new ApiException(422, 'unprocessable', 'the default pipeline has no open stage');
    if (!raw || raw.trim() === '') return { id: open.id, kind: 'open', match: 'fallback', unknown: false };
    const key = biginStageKey(raw);
    const mappedId = mapping.get(key);
    const mapped = mappedId ? stages.find((s) => s.id === mappedId) : undefined;
    if (mapped) return { id: mapped.id, kind: mapped.kind, match: 'mapped', unknown: false };
    const named = stages.find((s) => biginStageKey(s.name) === key);
    if (named) return { id: named.id, kind: named.kind, match: 'name', unknown: false };
    const kind: StageKind | null = /\bwon\b/.test(key) ? 'won' : /\blost\b/.test(key) ? 'lost' : null;
    const closed = kind ? stages.find((s) => s.kind === kind) : undefined;
    if (closed) return { id: closed.id, kind: closed.kind, match: 'closed', unknown: false };
    return { id: open.id, kind: 'open', match: 'fallback', unknown: true };
}

/** What a Deals link keeps of Bigin: the raw stage it was last read with. */
export interface DealSnapshot {
    stage: string | null;
}

/**
 * The Bigin stage a Deals link's snapshot holds: `undefined` when the link has none (the deal was imported
 * before stages were kept), `null` when Bigin had no stage on the deal.
 */
export function snapshotStage(snapshot: unknown): string | null | undefined {
    if (typeof snapshot !== 'object' || snapshot === null || !('stage' in snapshot)) return undefined;
    const stage = (snapshot as { stage: unknown }).stage;
    return typeof stage === 'string' ? stage : null;
}

/**
 * The values of the Deals `Stage` picklist in Zoho's fields answer (`GET /settings/fields?module=Deals`), in
 * Bigin's order, each once (its `actual_value`, which is what a record's `Stage` holds, else its display
 * value); null when the answer has no `Stage` field.
 */
export function stagePicklist(body: unknown): string[] | null {
    const fields = (body as { fields?: unknown } | null)?.fields;
    if (!Array.isArray(fields)) return null;
    const field = fields.find(
        (f): f is { pick_list_values?: unknown } =>
            typeof f === 'object' && f !== null && (f as { api_name?: unknown }).api_name === 'Stage',
    );
    if (!field || !Array.isArray(field.pick_list_values)) return null;
    const seen = new Set<string>();
    const values: string[] = [];
    for (const option of field.pick_list_values as unknown[]) {
        if (typeof option !== 'object' || option === null) continue;
        const { actual_value: actual, display_value: display } = option as Record<string, unknown>;
        const value = typeof actual === 'string' && actual.trim() ? actual : typeof display === 'string' ? display : '';
        if (!value.trim() || value === '-None-' || seen.has(biginStageKey(value))) continue;
        seen.add(biginStageKey(value));
        values.push(value.trim());
    }
    return values;
}
