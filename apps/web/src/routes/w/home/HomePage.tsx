import { PageHeader } from '@bylinecrm/ui';
import { useMemo, useState } from 'react';
import { readerTimeZone, useToday, type TodayParams } from '../../../api/today';
import { can, useMembership } from '../../../auth/capabilities';
import { useWorkspaceId } from '../../params';
import { DealFeedCard } from './DealFeedCard';
import { DashboardKpis, DealsByStageCard, PipelinePulseCard, TopCompaniesCard } from './PipelineCards';
import { TodayWork } from './TodayWork';
import { WelcomeBanner } from './WelcomeBanner';

/**
 * The dashboard (#192, #360), by role. Everyone gets the welcome first. An account manager (no
 * `workspace:admin`) then sees their day's work — replies waiting, follow-ups due, new leads, tasks due, stalled
 * deals — and the live deal feed. An admin sees the pipeline — the four numbers, the default pipeline at a
 * glance, deals by stage, the top companies — then the work list for the member they choose (themselves by
 * default), then the feed. Every figure is the API's.
 */
export function HomePage() {
    const workspaceId = useWorkspaceId();
    const admin = can(useMembership(), 'workspace:admin');
    const [memberId, setMemberId] = useState<string | undefined>(undefined);
    const params = useMemo<TodayParams>(() => ({ memberId, timeZone: readerTimeZone() }), [memberId]);
    // The work list's own query (one key, one request): the welcome counts what it holds.
    const day = useToday(workspaceId, params);
    const attention = day.data
        ? day.data.replies.count +
          day.data.followUps.count +
          day.data.newLeads.count +
          day.data.tasks.count +
          day.data.stalled.count
        : null;
    return (
        <div className="flex flex-col gap-4 p-4 md:p-6">
            <PageHeader
                className="mb-0"
                title="Dashboard"
                subtitle={
                    admin
                        ? 'Track your pipeline, and what needs each member today.'
                        : 'What needs you today, and what the team is doing with deals.'
                }
            />
            <WelcomeBanner workspaceId={workspaceId} attention={attention} />
            {admin && (
                <>
                    <DashboardKpis workspaceId={workspaceId} />
                    <div className="grid grid-cols-12 gap-4">
                        <PipelinePulseCard workspaceId={workspaceId} className="col-span-12 xl:col-span-7" />
                        <DealsByStageCard workspaceId={workspaceId} className="col-span-12 xl:col-span-5" />
                    </div>
                    <TopCompaniesCard workspaceId={workspaceId} />
                </>
            )}
            <TodayWork workspaceId={workspaceId} params={params} onMemberChange={setMemberId} />
            <DealFeedCard workspaceId={workspaceId} />
        </div>
    );
}
