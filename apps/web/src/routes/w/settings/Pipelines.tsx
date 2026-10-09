import { EmptyState } from '@bylinecrm/ui';
import { GitBranch } from 'lucide-react';

/**
 * Pipeline configuration — stages, order, colours, days-in-stage thresholds, the rule editor
 * (`pipeline:configure`) — is its own card (doc 50 §B "owed"). The route exists so the board's
 * "Configure pipeline" link lands somewhere that says so, not on a 404.
 */
export function Pipelines() {
    return (
        <EmptyState
            icon={<GitBranch />}
            title="Pipeline settings arrive with the next slice"
            body="Stages, their order and colours, days-in-stage thresholds and the stage-rule editor are built here. Until then, the default pipeline and its rules apply."
        />
    );
}
