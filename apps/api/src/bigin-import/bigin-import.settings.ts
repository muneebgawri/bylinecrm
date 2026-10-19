import {
    BIGIN_IMPORT_OBJECTS,
    emptyBiginObjectReport,
    type BiginImportMode,
    type BiginImportObject,
    type BiginImportObjectReport,
    type BiginImportRunStatus,
    type BiginImportRunView,
    type BiginImportSettingsView,
} from '@bylinecrm/shared';
import type { BiginImportRun, BiginImportSettings } from '@prisma/client';
import { StateConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import type { BiginConnection } from './bigin.port';

/**
 * The connection a workspace stored, opened: the client secret and refresh token are sealed at rest
 * (`SecretBox`) and leave the box only here, for a read of Bigin. Null when none is configured.
 */
export async function readBiginConnection(
    tx: WorkspaceClient,
    secrets: SecretBox,
): Promise<{ row: BiginImportSettings; connection: BiginConnection } | null> {
    const row = await tx.biginImportSettings.findFirst();
    if (!row) return null;
    return {
        row,
        connection: {
            accountsUrl: row.accountsUrl,
            apiUrl: row.apiUrl,
            clientId: row.clientId,
            clientSecret: secrets.open(row.clientSecretCiphertext),
            refreshToken: secrets.open(row.refreshTokenCiphertext),
        },
    };
}

export function biginSettingsView(row: BiginImportSettings | null): BiginImportSettingsView {
    if (!row) {
        return {
            configured: false,
            accountsUrl: null,
            apiUrl: null,
            clientId: null,
            refreshTokenLast4: null,
            configuredBy: null,
            updatedAt: null,
            createMembers: null,
        };
    }
    return {
        configured: true,
        accountsUrl: row.accountsUrl,
        apiUrl: row.apiUrl,
        clientId: row.clientId,
        refreshTokenLast4: row.refreshTokenLast4,
        configuredBy: row.configuredById,
        updatedAt: row.updatedAt.toISOString(),
        createMembers: row.createMembersRoleId ? { roleId: row.createMembersRoleId } : null,
    };
}

/** The report as saved, one entry per module in reading order; a counter added later reads as zero. */
export function biginReportFrom(saved: unknown): BiginImportObjectReport[] {
    const entries = Array.isArray(saved) ? (saved as BiginImportObjectReport[]) : [];
    return BIGIN_IMPORT_OBJECTS.map((object) => ({
        ...emptyBiginObjectReport(object),
        ...(entries.find((r) => r.object === object) ?? {}),
    }));
}

export function biginRunView(row: BiginImportRun): BiginImportRunView {
    const report = biginReportFrom(row.report);
    return {
        id: row.id,
        status: row.status as BiginImportRunStatus,
        mode: row.mode as BiginImportMode,
        phase: (row.phase as BiginImportObject | null) ?? null,
        report,
        error: row.error,
        failedRecords: report.reduce((sum, entry) => sum + entry.failed, 0),
        cancelRequested: row.cancelRequested,
        scheduled: row.scheduled,
        startedBy: row.startedById,
        createMembers: row.createMembersRoleId ? { roleId: row.createMembersRoleId } : null,
        accountsCreated: row.accountsCreated,
        queuedAt: row.queuedAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
    };
}

/**
 * Queues a run row — the one way a run starts, a person's or the schedule's. One queued or running run
 * per workspace (the partial unique index): a second is a `StateConflict`.
 */
export async function queueBiginRun(
    tx: WorkspaceClient,
    input: {
        workspaceId: string;
        mode: BiginImportMode;
        startedById: string | null;
        scheduled: boolean;
        createMembersRoleId?: string | null;
    },
): Promise<BiginImportRun> {
    try {
        return await tx.biginImportRun.create({
            data: {
                workspaceId: input.workspaceId,
                mode: input.mode,
                startedById: input.startedById,
                scheduled: input.scheduled,
                createMembersRoleId: input.createMembersRoleId ?? null,
            },
        });
    } catch (error) {
        if (uniqueViolation(error)) throw new StateConflict('an import is already queued or running');
        throw error;
    }
}
