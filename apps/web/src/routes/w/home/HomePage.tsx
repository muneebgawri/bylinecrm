import { PageHeader } from '@bylinecrm/ui';
import { useWorkspaceId } from '../../params';
import { MyTasksCard } from './MyTasksCard';
import { DashboardKpis, DealsByStageCard, PipelinePulseCard, TopCompaniesCard } from './PipelineCards';

/**
 * The dashboard (#192): the four numbers (people, open deals, pipeline value, won revenue), the
 * default pipeline at a glance, the deals by stage, the companies with the most open value, and
 * **My tasks**. Every figure is the API's; nothing here is estimated.
 */
export function HomePage() {
    const workspaceId = useWorkspaceId();
    return (
        <div className="flex flex-col gap-4 p-4 md:p-6">
            <PageHeader
                className="mb-0"
                title="Dashboard"
                subtitle="Track your pipeline, your deals and what needs you today."
            />
            <DashboardKpis workspaceId={workspaceId} />
            <div className="grid grid-cols-12 gap-4">
                <PipelinePulseCard workspaceId={workspaceId} className="col-span-12 xl:col-span-7" />
                <DealsByStageCard workspaceId={workspaceId} className="col-span-12 xl:col-span-5" />
            </div>
            <div className="grid grid-cols-12 gap-4">
                <TopCompaniesCard workspaceId={workspaceId} className="col-span-12 lg:col-span-5" />
                <MyTasksCard workspaceId={workspaceId} className="col-span-12 lg:col-span-7" />
            </div>
        </div>
    );
}
