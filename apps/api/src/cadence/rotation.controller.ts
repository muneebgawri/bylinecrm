import { Body, Get, Param, ParseUUIDPipe, Patch, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
    MAILBOX_PREFERENCES,
    ROTATION_PREVIEW_ACTIONS,
    ROTATION_WEIGHT_MAX,
    type RotationMemberView,
    type RotationPreviewView,
    type RotationSettingsView,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Requires, TenantController } from '../auth/decorators';
import { id, named, Returns } from '../openapi/responses';
import { RotationSettingsService } from './rotation-settings.service';

const days = (max: number) => z.number().int().min(0).max(max);
const isoTime = z.iso.datetime({ offset: true });
const member = z.object({ memberId: id, name: z.string().nullable() });

const settingsFields = {
    enabled: z.boolean().meta({
        description:
            'Rotation on: lapsed leads warn their owner and, a grace later, rotate. Switching it on stamps `enabledAt`; lapses are measured from then, so an existing backlog never rotates at once.',
    }),
    warnAfterDays: days(90).meta({ description: 'Days past a missed cadence before the owner is warned.' }),
    graceDays: days(90)
        .min(1)
        .meta({ description: 'Days after the warning, still without a touch, before the lead rotates.' }),
    intakeEnabled: z.boolean().meta({ description: 'New unowned leads are dealt to the next rep in turn.' }),
    mailboxPreference: z.enum(MAILBOX_PREFERENCES).meta({
        description:
            '`prefer`: reps with a connected or delegated mailbox, when any has one; `require`: only those; `ignore`.',
    }),
    openLeadCap: z
        .number()
        .int()
        .min(1)
        .nullable()
        .meta({ description: 'A rep holding this many open deals is skipped; null: no cap.' }),
};

export class RotationSettingsDto extends createZodDto(z.object(settingsFields)) {}
export const rotationSettingsView = named(
    'RotationSettings',
    z.object({ ...settingsFields, enabledAt: isoTime.nullable() }),
);

export class RotationMemberDto extends createZodDto(
    z.object({
        included: z
            .boolean()
            .nullable()
            .optional()
            .meta({ description: 'In or out of the rotation; null: their role’s default.' }),
        paused: z.boolean().optional(),
        resumeAt: isoTime
            .nullable()
            .optional()
            .meta({ description: 'When the pause ends by itself; setting it pauses.' }),
        weight: z.number().int().min(1).max(ROTATION_WEIGHT_MAX).optional(),
    }),
) {}

export const rotationMemberView = named(
    'RotationMember',
    z.object({
        memberId: id,
        name: z.string().nullable(),
        email: z.string(),
        roleName: z.string(),
        included: z.boolean(),
        includedByDefault: z.boolean().meta({ description: 'Admins and managers are out by default.' }),
        paused: z.boolean(),
        resumeAt: isoTime.nullable(),
        weight: z.number().int(),
        hasMailbox: z.boolean(),
        openLeads: z.number().int(),
        eligible: z.boolean().meta({ description: 'Dealt to now.' }),
    }),
);

export const rotationPreviewView = named(
    'RotationPreview',
    z.object({
        assumedEnabledAt: isoTime.meta({ description: 'When rotation is off: as if switched on now.' }),
        overdue: z.number().int(),
        items: z.array(
            z.object({
                opportunityId: id,
                opportunityName: z.string(),
                stageName: z.string(),
                cadenceDays: z.number().int(),
                owner: member,
                lastTouchAt: isoTime,
                dueAt: isoTime,
                warnAt: isoTime,
                rotateAt: isoTime,
                action: z.enum(ROTATION_PREVIEW_ACTIONS),
                to: member.nullable(),
            }),
        ),
    }),
);

/**
 * Settings → Rotation (CADENCE-1): the cadence rotation's settings, who is in it, and a dry run of what the hourly
 * job would do. Holders of `pipeline:cadence` (admins and the `manager` role).
 */
@ApiTags('rotation')
@TenantController('rotation')
export class RotationController {
    constructor(private readonly settings: RotationSettingsService) {}

    @Requires('pipeline:cadence')
    @Get('settings')
    @Returns(rotationSettingsView)
    get(): Promise<RotationSettingsView> {
        return this.settings.get();
    }

    @Requires('pipeline:cadence')
    @Put('settings')
    @Returns(rotationSettingsView)
    set(@Body() body: RotationSettingsDto): Promise<RotationSettingsView> {
        return this.settings.set(body);
    }

    @Requires('pipeline:cadence')
    @Get('members')
    @Returns([rotationMemberView])
    members(): Promise<RotationMemberView[]> {
        return this.settings.members();
    }

    /** Pause or unpause a member (optionally until a date), take them in or out, or weight their turns. */
    @Requires('pipeline:cadence')
    @Patch('members/:memberId')
    @Returns(rotationMemberView)
    setMember(
        @Param('memberId', ParseUUIDPipe) memberId: string,
        @Body() body: RotationMemberDto,
    ): Promise<RotationMemberView> {
        return this.settings.setMember(memberId, body);
    }

    /** Every overdue open lead and what rotation would do with it on the next run. Nothing is written. */
    @Requires('pipeline:cadence')
    @Get('preview')
    @Returns(rotationPreviewView)
    preview(): Promise<RotationPreviewView> {
        return this.settings.preview();
    }
}
