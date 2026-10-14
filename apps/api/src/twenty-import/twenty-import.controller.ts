import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
    TwentyImportMissingView,
    TwentyImportOverview,
    TwentyImportPreview,
    TwentyImportRunView,
    TwentyImportSettingsView,
    TwentyImportSyncView,
} from '@bylinecrm/shared';
import type { Page } from '../records/list-query';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import {
    ListTwentyImportMissingDto,
    PutTwentyImportSettingsDto,
    PutTwentyImportSyncDto,
    StartTwentyImportDto,
} from './dto';
import {
    twentyImportMissingPage,
    twentyImportOverview,
    twentyImportPreview,
    twentyImportRun,
    twentyImportSettings,
    twentyImportSync,
} from './responses';
import { TwentyImportService } from './twenty-import.service';

/** The Twenty importer (P4-4, doc 48 §11): an admin's — it writes every object the workspace has. */
@ApiTags('twenty-import')
@TenantController('import/twenty')
export class TwentyImportController {
    constructor(private readonly importer: TwentyImportService) {}

    @Requires('workspace:admin')
    @Get()
    @Returns(twentyImportOverview)
    overview(): Promise<TwentyImportOverview> {
        return this.importer.overview();
    }

    @Requires('workspace:admin')
    @Put('settings')
    @Returns(twentyImportSettings)
    putSettings(@Body() body: PutTwentyImportSettingsDto): Promise<TwentyImportSettingsView> {
        return this.importer.putSettings(body);
    }

    /** What a reconcile pass flagged as missing in Twenty (#156), for review; nothing here is deleted on its own. */
    @Requires('workspace:admin')
    @Get('missing')
    @Returns(twentyImportMissingPage)
    missing(@Query() query: ListTwentyImportMissingDto): Promise<Page<TwentyImportMissingView>> {
        return this.importer.missing(query);
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete('settings')
    removeSettings(): Promise<void> {
        return this.importer.removeSettings();
    }

    /** The automatic sync (#185): off, every 15 minutes, hourly or daily. Turning it on undoes a cutover. */
    @Requires('workspace:admin')
    @Put('sync')
    @Returns(twentyImportSync)
    putSync(@Body() body: PutTwentyImportSyncDto): Promise<TwentyImportSyncView> {
        return this.importer.putSync(body.interval);
    }

    /** Stop syncing (cutover, #185): the schedule is off for good and the moment is recorded. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('sync/cutover')
    @Returns(twentyImportSync)
    cutover(): Promise<TwentyImportSyncView> {
        return this.importer.cutover();
    }

    /** Reads Twenty now: its count per object beside what is mapped here. A refused key is a `422` at `apiKey`. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('preview')
    @Returns(twentyImportPreview)
    preview(): Promise<TwentyImportPreview> {
        return this.importer.preview();
    }

    @Requires('workspace:admin')
    @HttpCode(202)
    @Post('runs')
    @Returns(twentyImportRun)
    start(@Body() body: StartTwentyImportDto): Promise<TwentyImportRunView> {
        return this.importer.start(body.mode);
    }

    @Requires('workspace:admin')
    @Get('runs')
    @Returns([twentyImportRun])
    runs(): Promise<TwentyImportRunView[]> {
        return this.importer.runs();
    }

    @Requires('workspace:admin')
    @Get('runs/:runId')
    @Returns(twentyImportRun)
    run(@Param('runId', ParseUUIDPipe) runId: string): Promise<TwentyImportRunView> {
        return this.importer.run(runId);
    }

    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('runs/:runId/cancel')
    @Returns(twentyImportRun)
    cancel(@Param('runId', ParseUUIDPipe) runId: string): Promise<TwentyImportRunView> {
        return this.importer.cancel(runId);
    }
}
