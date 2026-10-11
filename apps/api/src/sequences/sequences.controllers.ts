import { Body, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
    EnrolmentBatchResult,
    EnrolmentView,
    OutreachExclusionView,
    RegionPolicyEntry,
    SequenceView,
} from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import {
    CreateExclusionDto,
    CreateSequenceDto,
    EnrolDto,
    PreviewEnrolDto,
    PutSequenceStepsDto,
    RemoveExclusionDto,
    SetRegionPolicyDto,
    StopEnrolmentDto,
    UpdateSequenceDto,
} from './dto';
import { EnrolmentsService } from './enrolments.service';
import { ExclusionsService } from './exclusions.service';
import { RegionPolicyService } from './region-policy.service';
import {
    enrolmentBatchResult,
    enrolmentView,
    outreachExclusionView,
    regionPolicyEntry,
    sequenceView,
} from './responses';
import { SequencesService } from './sequences.service';

/**
 * Sequences (P3-3, doc 50 §D): `sequence:write` builds them (create, steps, activate, pause, archive);
 * `sequence:enrol` reads them and puts people in. A sequence is the workspace's, not a member's.
 */
@ApiTags('sequences')
@TenantController('sequences')
export class SequencesController {
    constructor(
        private readonly sequences: SequencesService,
        private readonly enrolments: EnrolmentsService,
    ) {}

    @Requires('sequence:enrol')
    @Get()
    @Returns([sequenceView])
    list(): Promise<SequenceView[]> {
        return this.sequences.list();
    }

    @Requires('sequence:write')
    @Post()
    @Returns(sequenceView)
    create(@Body() body: CreateSequenceDto): Promise<SequenceView> {
        return this.sequences.create(body);
    }

    @Requires('sequence:enrol')
    @Get(':sequenceId')
    @Returns(sequenceView)
    get(@Param('sequenceId', ParseUUIDPipe) id: string): Promise<SequenceView> {
        return this.sequences.get(id);
    }

    @Requires('sequence:write')
    @Patch(':sequenceId')
    @Returns(sequenceView)
    update(@Param('sequenceId', ParseUUIDPipe) id: string, @Body() body: UpdateSequenceDto): Promise<SequenceView> {
        return this.sequences.update(id, body);
    }

    @Requires('sequence:write')
    @Put(':sequenceId/steps')
    @Returns(sequenceView)
    putSteps(@Param('sequenceId', ParseUUIDPipe) id: string, @Body() body: PutSequenceStepsDto): Promise<SequenceView> {
        return this.sequences.putSteps(id, body.steps);
    }

    @Requires('sequence:write')
    @HttpCode(200)
    @Post(':sequenceId/activate')
    @Returns(sequenceView)
    activate(@Param('sequenceId', ParseUUIDPipe) id: string): Promise<SequenceView> {
        return this.sequences.activate(id);
    }

    @Requires('sequence:write')
    @HttpCode(200)
    @Post(':sequenceId/pause')
    @Returns(sequenceView)
    pause(@Param('sequenceId', ParseUUIDPipe) id: string): Promise<SequenceView> {
        return this.sequences.pause(id);
    }

    @Requires('sequence:write')
    @HttpCode(200)
    @Post(':sequenceId/resume')
    @Returns(sequenceView)
    resume(@Param('sequenceId', ParseUUIDPipe) id: string): Promise<SequenceView> {
        return this.sequences.resume(id);
    }

    @Requires('sequence:write')
    @HttpCode(200)
    @Post(':sequenceId/archive')
    @Returns(sequenceView)
    archive(@Param('sequenceId', ParseUUIDPipe) id: string): Promise<SequenceView> {
        return this.sequences.archive(id);
    }

    @Requires('sequence:enrol')
    @Get(':sequenceId/enrolments')
    @Returns([enrolmentView])
    enrolmentList(@Param('sequenceId', ParseUUIDPipe) id: string): Promise<EnrolmentView[]> {
        return this.enrolments.list(id);
    }

    /** What an enrol would do now: the same decision, nothing written. */
    @Requires('sequence:enrol')
    @HttpCode(200)
    @Post(':sequenceId/enrolments/preview')
    @Returns(enrolmentBatchResult)
    preview(
        @Param('sequenceId', ParseUUIDPipe) id: string,
        @Body() body: PreviewEnrolDto,
    ): Promise<EnrolmentBatchResult> {
        return this.enrolments.preview(id, body.personIds);
    }

    @Requires('sequence:enrol')
    @HttpCode(200)
    @Post(':sequenceId/enrolments')
    @Returns(enrolmentBatchResult)
    enrol(@Param('sequenceId', ParseUUIDPipe) id: string, @Body() body: EnrolDto): Promise<EnrolmentBatchResult> {
        return this.enrolments.enrol(id, body.personIds, body.dealId);
    }
}

/** One enrolment: stop it, re-enrol it from step 1 (naming the earlier stop), resume a held one. */
@ApiTags('sequences')
@TenantController('enrolments')
export class EnrolmentsController {
    constructor(private readonly enrolments: EnrolmentsService) {}

    @Requires('sequence:enrol')
    @HttpCode(200)
    @Post(':enrolmentId/stop')
    @Returns(enrolmentView)
    stop(@Param('enrolmentId', ParseUUIDPipe) id: string, @Body() body: StopEnrolmentDto): Promise<EnrolmentView> {
        return this.enrolments.stop(id, body.note);
    }

    @Requires('sequence:enrol')
    @HttpCode(200)
    @Post(':enrolmentId/reenrol')
    @Returns(enrolmentView)
    reenrol(@Param('enrolmentId', ParseUUIDPipe) id: string): Promise<EnrolmentView> {
        return this.enrolments.reenrol(id);
    }

    @Requires('sequence:enrol')
    @HttpCode(200)
    @Post(':enrolmentId/resume')
    @Returns(enrolmentView)
    resume(@Param('enrolmentId', ParseUUIDPipe) id: string): Promise<EnrolmentView> {
        return this.enrolments.resume(id);
    }
}

/** A person's enrolments, for their record page. */
@ApiTags('sequences')
@TenantController('people')
export class PersonEnrolmentsController {
    constructor(private readonly enrolments: EnrolmentsService) {}

    @Requires('record:read')
    @Get(':personId/enrolments')
    @Returns([enrolmentView])
    list(@Param('personId', ParseUUIDPipe) personId: string): Promise<EnrolmentView[]> {
        return this.enrolments.forPerson(personId);
    }
}

/** Outreach compliance: the region policy (FR-CRMS-12) and the exclusion list (FR-CRMS-10). */
@ApiTags('sequences')
@TenantController('outreach')
export class OutreachComplianceController {
    constructor(
        private readonly regions: RegionPolicyService,
        private readonly exclusions: ExclusionsService,
    ) {}

    @Requires('outreach:write')
    @Get('region-policy')
    @Returns([regionPolicyEntry])
    regionPolicy(): Promise<RegionPolicyEntry[]> {
        return this.regions.list();
    }

    @Requires('workspace:admin')
    @Put('region-policy')
    @Returns([regionPolicyEntry])
    setRegionPolicy(@Body() body: SetRegionPolicyDto): Promise<RegionPolicyEntry[]> {
        return this.regions.set(body);
    }

    @Requires('workspace:admin')
    @Get('exclusions')
    @Returns([outreachExclusionView])
    exclusionList(): Promise<OutreachExclusionView[]> {
        return this.exclusions.list();
    }

    /** Fed by the integration (P5-1, `source` its key) and by an admin. */
    @Requires('workspace:admin')
    @Post('exclusions')
    @Returns(outreachExclusionView)
    addExclusion(@Body() body: CreateExclusionDto): Promise<OutreachExclusionView> {
        return this.exclusions.add(body);
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Post('exclusions/:exclusionId/remove')
    async removeExclusion(
        @Param('exclusionId', ParseUUIDPipe) id: string,
        @Body() body: RemoveExclusionDto,
    ): Promise<void> {
        await this.exclusions.remove(id, body.note);
    }
}
