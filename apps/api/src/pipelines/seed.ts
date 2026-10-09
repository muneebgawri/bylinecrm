import { DEFAULT_PIPELINE_NAME, DEFAULT_STAGES } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';

/**
 * The default pipeline a workspace starts with, from the one stage list in `@bylinecrm/shared`.
 * `AuthService` calls this when it creates a workspace (through the owner client, like the rest
 * of workspace creation); the migration that introduced pipelines backfilled the workspaces that
 * already existed from the same list, and a unit test keeps the two in step.
 */
export async function seedDefaultPipeline(
    tx: Prisma.TransactionClient,
    workspaceId: string,
): Promise<{ pipelineId: string; firstStageId: string }> {
    const pipeline = await tx.pipeline.create({
        data: { workspaceId, name: DEFAULT_PIPELINE_NAME, isDefault: true },
    });
    const stages = await Promise.all(
        DEFAULT_STAGES.map((stage, index) =>
            tx.pipelineStage.create({
                data: {
                    workspaceId,
                    pipelineId: pipeline.id,
                    name: stage.name,
                    position: index + 1,
                    probability: stage.probability,
                    kind: stage.kind,
                    colour: stage.colour,
                },
            }),
        ),
    );
    const first = stages[0];
    if (!first) throw new Error('DEFAULT_STAGES is empty');
    return { pipelineId: pipeline.id, firstStageId: first.id };
}
