import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import {
    BoardQueryDto,
    CreatePipelineDto,
    CreateRuleDto,
    CreateStageDto,
    DeleteStageQueryDto,
    HistoryQueryDto,
    MoveDealDto,
    OrderStagesDto,
    UpdatePipelineDto,
    UpdateRuleDto,
    UpdateStageDto,
} from './dto';
import {
    PipelinesService,
    type BoardView,
    type HistoryEntry,
    type MoveResult,
    type PipelineView,
    type RuleView,
    type StageView,
} from './pipelines.service';
import { Returns } from '../openapi/responses';
import { boardView, historyEntry, moveResult, pipelineView, ruleView, stageView } from './responses';

/** Pipelines are read by anyone who reads deals and changed with `pipeline:configure`. */
@ApiTags('pipelines')
@TenantController('pipelines')
export class PipelinesController {
    constructor(private readonly pipelines: PipelinesService) {}

    @Requires('deal:read')
    @Get()
    @Returns([pipelineView])
    list(): Promise<PipelineView[]> {
        return this.pipelines.list();
    }

    @Requires('deal:read')
    @Get(':pipelineId')
    @Returns(pipelineView)
    get(@Param('pipelineId', ParseUUIDPipe) pipelineId: string): Promise<PipelineView> {
        return this.pipelines.get(pipelineId);
    }

    @Requires('deal:read')
    @Get(':pipelineId/board')
    @Returns(boardView)
    board(@Param('pipelineId', ParseUUIDPipe) pipelineId: string, @Query() query: BoardQueryDto): Promise<BoardView> {
        return this.pipelines.board(pipelineId, query);
    }

    @Requires('pipeline:configure')
    @Post()
    @Returns(pipelineView)
    create(@Body() body: CreatePipelineDto): Promise<PipelineView> {
        return this.pipelines.create(body);
    }

    @Requires('pipeline:configure')
    @Patch(':pipelineId')
    @Returns(pipelineView)
    update(
        @Param('pipelineId', ParseUUIDPipe) pipelineId: string,
        @Body() body: UpdatePipelineDto,
    ): Promise<PipelineView> {
        return this.pipelines.update(pipelineId, body);
    }

    @Requires('pipeline:configure')
    @HttpCode(204)
    @Delete(':pipelineId')
    remove(@Param('pipelineId', ParseUUIDPipe) pipelineId: string): Promise<void> {
        return this.pipelines.remove(pipelineId);
    }

    @Requires('pipeline:configure')
    @Post(':pipelineId/stages')
    @Returns(stageView)
    addStage(@Param('pipelineId', ParseUUIDPipe) pipelineId: string, @Body() body: CreateStageDto): Promise<StageView> {
        return this.pipelines.addStage(pipelineId, body);
    }

    @Requires('pipeline:configure')
    @Put(':pipelineId/stages/order')
    @Returns(pipelineView)
    orderStages(
        @Param('pipelineId', ParseUUIDPipe) pipelineId: string,
        @Body() body: OrderStagesDto,
    ): Promise<PipelineView> {
        return this.pipelines.orderStages(pipelineId, body.stageIds);
    }

    @Requires('pipeline:configure')
    @Patch(':pipelineId/stages/:stageId')
    @Returns(stageView)
    updateStage(
        @Param('pipelineId', ParseUUIDPipe) pipelineId: string,
        @Param('stageId', ParseUUIDPipe) stageId: string,
        @Body() body: UpdateStageDto,
    ): Promise<StageView> {
        return this.pipelines.updateStage(pipelineId, stageId, body);
    }

    /**
     * Deletes a stage. With deals in it (trash included) it needs `?moveDealsTo=<open stage id>`:
     * they move there first, one event each. In the query string, not a body: DELETE bodies do
     * not reliably survive proxies.
     */
    @Requires('pipeline:configure')
    @HttpCode(204)
    @Delete(':pipelineId/stages/:stageId')
    removeStage(
        @Param('pipelineId', ParseUUIDPipe) pipelineId: string,
        @Param('stageId', ParseUUIDPipe) stageId: string,
        @Query() query: DeleteStageQueryDto,
    ): Promise<void> {
        return this.pipelines.removeStage(pipelineId, stageId, query.moveDealsTo);
    }

    @Requires('deal:read')
    @Get(':pipelineId/rules')
    @Returns([ruleView])
    listRules(@Param('pipelineId', ParseUUIDPipe) pipelineId: string): Promise<RuleView[]> {
        return this.pipelines.listRules(pipelineId);
    }

    @Requires('pipeline:configure')
    @Post(':pipelineId/rules')
    @Returns(ruleView)
    createRule(@Param('pipelineId', ParseUUIDPipe) pipelineId: string, @Body() body: CreateRuleDto): Promise<RuleView> {
        return this.pipelines.createRule(pipelineId, body);
    }

    @Requires('pipeline:configure')
    @Patch(':pipelineId/rules/:ruleId')
    @Returns(ruleView)
    updateRule(
        @Param('pipelineId', ParseUUIDPipe) pipelineId: string,
        @Param('ruleId', ParseUUIDPipe) ruleId: string,
        @Body() body: UpdateRuleDto,
    ): Promise<RuleView> {
        return this.pipelines.updateRule(pipelineId, ruleId, body);
    }

    @Requires('pipeline:configure')
    @HttpCode(204)
    @Delete(':pipelineId/rules/:ruleId')
    removeRule(
        @Param('pipelineId', ParseUUIDPipe) pipelineId: string,
        @Param('ruleId', ParseUUIDPipe) ruleId: string,
    ): Promise<void> {
        return this.pipelines.removeRule(pipelineId, ruleId);
    }
}

/** A deal's place in its pipeline: moving it is `deal:move`; its history is reading it. */
@ApiTags('opportunities')
@TenantController('opportunities')
export class DealStageController {
    constructor(private readonly pipelines: PipelinesService) {}

    @Requires('deal:move')
    @Post(':opportunityId/move')
    @Returns(moveResult)
    move(@Param('opportunityId', ParseUUIDPipe) opportunityId: string, @Body() body: MoveDealDto): Promise<MoveResult> {
        return this.pipelines.move(opportunityId, body.stageId, body.close);
    }

    @Requires('deal:read')
    @Get(':opportunityId/history')
    @Returns([historyEntry])
    history(
        @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
        @Query() query: HistoryQueryDto,
    ): Promise<HistoryEntry[]> {
        return this.pipelines.history(opportunityId, query.limit);
    }
}
