import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../records/custom-fields/custom-fields.module';
import { DealStageController, PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';
import { StageMoveService } from './stage-move.service';
import { StageRulesService } from './stage-rules.service';

/**
 * Pipelines, their stages, the history of a deal's moves and the rules that move deals (P1-2).
 * `StageMoveService` is the one writer of a deal's stage; `RecordsModule` imports this module to
 * place a new deal through it.
 */
@Module({
    imports: [CustomFieldsModule],
    controllers: [PipelinesController, DealStageController],
    providers: [PipelinesService, StageMoveService, StageRulesService],
    exports: [StageMoveService, StageRulesService],
})
export class PipelinesModule {}
