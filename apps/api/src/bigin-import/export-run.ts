import { Injectable } from '@nestjs/common';
import type { BiginImportRunView } from '@bylinecrm/shared';
import { StateConflict } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { BiginExport, type BiginExportOptions } from './bigin-export';
import { biginRunView, queueBiginRun } from './bigin-import.settings';
import { BiginImportRunner } from './import-runner';

/**
 * A full run from a Bigin backup export (BIGIN-1), driven in this process by the operator's CLI
 * (`import-bigin-export`): the same run row, runner, links, reuse handling and report as a run read from the API,
 * with `source: 'export'`. One run is queued or running per workspace, whatever it reads: an open API run refuses
 * this one (`StateConflict`), and an export run left open (the process died) is resumed from its cursors — by
 * this, never by a worker, which has no files to read it from.
 */
@Injectable()
export class BiginExportImport {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly runner: BiginImportRunner,
    ) {}

    async run(workspaceId: string, dir: string, options: BiginExportOptions = {}): Promise<BiginImportRunView> {
        // Opened before a run row exists: a directory that is no export (or names no time zone) starts nothing.
        const source = await BiginExport.open(dir, options);
        const runId = await this.rls.withWorkspace(workspaceId, async (tx) => {
            const open = await tx.biginImportRun.findFirst({ where: { status: { in: ['queued', 'running'] } } });
            if (open) {
                if (open.source !== 'export') throw new StateConflict('an import is already queued or running');
                return open.id;
            }
            const settings = await tx.biginImportSettings.findFirst({ select: { createMembersRoleId: true } });
            const queued = await queueBiginRun(tx, {
                workspaceId,
                mode: 'full',
                startedById: null,
                scheduled: false,
                // The workspace's choice for its runs: owners who are not members get an account, or not.
                createMembersRoleId: settings?.createMembersRoleId ?? null,
                source: 'export',
            });
            return queued.id;
        });
        await this.runner.run(runId, source);
        return this.rls.withWorkspace(workspaceId, async (tx) =>
            biginRunView(await tx.biginImportRun.findUniqueOrThrow({ where: { id: runId } })),
        );
    }
}
