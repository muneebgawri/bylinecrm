import type {
    TwentyImportMode,
    TwentyImportObject,
    TwentyImportObjectReport,
    TwentyImportRunStatus,
    TwentyImportRunView,
    TwentyImportSettingsView,
} from '@bylinecrm/shared';
import type { TwentyImportRun, TwentyImportSettings } from '@prisma/client';
import { SecretBox } from '../infra/secret-box';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { TwentyConnection } from './twenty.port';

/**
 * The connection a workspace stored, opened: the key is sealed at rest (`SecretBox`) and leaves
 * the box only here, for a read of Twenty. Null when no connection is configured. Read inside the
 * caller's transaction; the read of Twenty itself happens after it ends.
 */
export async function readConnection(
    tx: WorkspaceClient,
    secrets: SecretBox,
): Promise<{ row: TwentyImportSettings; connection: TwentyConnection } | null> {
    const row = await tx.twentyImportSettings.findFirst();
    if (!row) return null;
    return { row, connection: { baseUrl: row.baseUrl, apiKey: secrets.open(row.apiKeyCiphertext) } };
}

export function settingsView(row: TwentyImportSettings | null): TwentyImportSettingsView {
    if (!row) return { configured: false, baseUrl: null, apiKeyLast4: null, configuredBy: null, updatedAt: null };
    return {
        configured: true,
        baseUrl: row.baseUrl,
        apiKeyLast4: row.apiKeyLast4,
        configuredBy: row.configuredById,
        updatedAt: row.updatedAt.toISOString(),
    };
}

export function runView(row: TwentyImportRun): TwentyImportRunView {
    return {
        id: row.id,
        status: row.status as TwentyImportRunStatus,
        mode: row.mode as TwentyImportMode,
        since: row.since?.toISOString() ?? null,
        phase: (row.phase as TwentyImportObject | null) ?? null,
        report: row.report as unknown as TwentyImportObjectReport[],
        error: row.error,
        cancelRequested: row.cancelRequested,
        startedBy: row.startedById,
        queuedAt: row.queuedAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
    };
}
