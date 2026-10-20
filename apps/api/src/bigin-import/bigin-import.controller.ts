import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
    BiginContactReuseView,
    BiginImportMissingView,
    BiginImportOverview,
    BiginImportPreview,
    BiginImportRunView,
    BiginImportSettingsView,
    BiginImportSyncView,
    BiginStageApplyView,
    BiginStageMapView,
} from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import type { Page } from '../records/list-query';
import { BiginImportService } from './bigin-import.service';
import {
    ListBiginContactReusesDto,
    ListBiginImportMissingDto,
    PutBiginImportSettingsDto,
    PutBiginImportSyncDto,
    PutBiginStageMapDto,
    StartBiginImportDto,
} from './dto';
import {
    biginContactReusePage,
    biginImportMissingPage,
    biginImportOverview,
    biginImportPreview,
    biginImportRun,
    biginImportSettings,
    biginImportSync,
    biginStageApply,
    biginStageMap,
} from './responses';
import { BiginStageMapService } from './stage-map.service';

/** The Bigin importer (BIGIN-1, FR-CRMS-25): an admin's — it writes every record the workspace has. */
@ApiTags('bigin-import')
@TenantController('import/bigin')
export class BiginImportController {
    constructor(
        private readonly importer: BiginImportService,
        private readonly stageMap: BiginStageMapService,
    ) {}

    /** Bigin's deal stages (read now), imported deals per stage, and where each lands in the default pipeline. */
    @Requires('workspace:admin')
    @Get('stage-map')
    @Returns(biginStageMap)
    getStageMap(): Promise<BiginStageMapView> {
        return this.stageMap.view();
    }

    @Requires('workspace:admin')
    @Put('stage-map')
    @Returns(biginStageMap)
    putStageMap(@Body() body: PutBiginStageMapDto): Promise<BiginStageMapView> {
        return this.stageMap.put(body.mappings);
    }

    /** Queues moving imported deals to where their Bigin stage maps; deals moved by hand since are left. */
    @Requires('workspace:admin')
    @HttpCode(202)
    @Post('stage-map/apply')
    @Returns(biginStageApply)
    applyStageMap(): Promise<BiginStageApplyView> {
        return this.stageMap.apply();
    }

    @Requires('workspace:admin')
    @Get()
    @Returns(biginImportOverview)
    overview(): Promise<BiginImportOverview> {
        return this.importer.overview();
    }

    @Requires('workspace:admin')
    @Put('settings')
    @Returns(biginImportSettings)
    putSettings(@Body() body: PutBiginImportSettingsDto): Promise<BiginImportSettingsView> {
        return this.importer.putSettings(body);
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete('settings')
    removeSettings(): Promise<void> {
        return this.importer.removeSettings();
    }

    /** What Bigin deleted that is mapped here, for review; nothing here is deleted on its own. */
    @Requires('workspace:admin')
    @Get('missing')
    @Returns(biginImportMissingPage)
    missing(@Query() query: ListBiginImportMissingDto): Promise<Page<BiginImportMissingView>> {
        return this.importer.missing(query);
    }

    /** Bigin Contacts edited to hold a different person: the earlier person kept, the new one made, newest first. */
    @Requires('workspace:admin')
    @Get('reuses')
    @Returns(biginContactReusePage)
    reuses(@Query() query: ListBiginContactReusesDto): Promise<Page<BiginContactReuseView>> {
        return this.importer.reuses(query);
    }

    @Requires('workspace:admin')
    @Put('sync')
    @Returns(biginImportSync)
    putSync(@Body() body: PutBiginImportSyncDto): Promise<BiginImportSyncView> {
        return this.importer.putSync(body.interval);
    }

    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('sync/cutover')
    @Returns(biginImportSync)
    cutover(): Promise<BiginImportSyncView> {
        return this.importer.cutover();
    }

    /** Reads Bigin now: its count per module beside what is mapped here. Refused credentials are a `422`. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('preview')
    @Returns(biginImportPreview)
    preview(): Promise<BiginImportPreview> {
        return this.importer.preview();
    }

    @Requires('workspace:admin')
    @HttpCode(202)
    @Post('runs')
    @Returns(biginImportRun)
    start(@Body() body: StartBiginImportDto): Promise<BiginImportRunView> {
        return this.importer.start(body.mode, body.createMembers);
    }

    @Requires('workspace:admin')
    @Get('runs')
    @Returns([biginImportRun])
    runs(): Promise<BiginImportRunView[]> {
        return this.importer.runs();
    }

    @Requires('workspace:admin')
    @Get('runs/:runId')
    @Returns(biginImportRun)
    run(@Param('runId', ParseUUIDPipe) runId: string): Promise<BiginImportRunView> {
        return this.importer.run(runId);
    }

    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('runs/:runId/cancel')
    @Returns(biginImportRun)
    cancel(@Param('runId', ParseUUIDPipe) runId: string): Promise<BiginImportRunView> {
        return this.importer.cancel(runId);
    }
}
