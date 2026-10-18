import type { SequenceVisibility } from '@bylinecrm/shared';
import type { RadioOption } from '@bylinecrm/ui';

/** Who sees a sequence (#192), said one way wherever it is chosen. */
export const VISIBILITY_OPTIONS: readonly RadioOption<SequenceVisibility>[] = [
    {
        value: 'shared',
        label: 'Shared',
        description: 'Everyone who runs outreach sees it and can enrol people into it.',
    },
    { value: 'private', label: 'Only me', description: 'Only you and the workspace’s admins see it.' },
];

export const VISIBILITY_LEGEND = 'Who sees it';
