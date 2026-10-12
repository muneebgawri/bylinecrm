import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
    TwentyImportOverview,
    TwentyImportPreview,
    TwentyImportRunView,
    TwentyImportSettingsView,
} from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { PutTwentyImportSettingsDto, StartTwentyImportDto } from './dto';
import { twentyImportOverview, twentyImportPreview, twentyImportRun, twentyImportSettings } from './responses';
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

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete('settings')
    removeSettings(): Promise<void> {
        return this.importer.removeSettings();
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
