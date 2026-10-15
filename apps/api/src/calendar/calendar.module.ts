import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailAccountsModule } from '../mail-accounts/mail-accounts.module';
import { RecordsModule } from '../records/records.module';
import { CalendarSyncController, MeetingsController } from './calendar.controllers';
import { CALENDAR_SYNC_JOB_ATTEMPTS, CALENDAR_SYNC_JOB_BACKOFF_MS, CALENDAR_SYNC_QUEUE } from './calendar.constants';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendarSyncSubscriber } from './calendar-sync.subscriber';
import { CalendarSyncWorkers } from './calendar-sync.workers';
import { GoogleCalendarHttp } from './google-calendar.http';
import { GOOGLE_CALENDAR_PORT } from './google-calendar.port';
import { LeadSuggestionsService } from './lead-suggestions.service';
import { MeetingStore } from './meeting-store';
import { MeetingsService } from './meetings.service';
import { SlotlineHookController, SlotlineSettingsController } from './slotline/slotline.controllers';
import { SlotlineHookService } from './slotline/slotline-hook.service';
import { SlotlineSettingsService } from './slotline/slotline-settings.service';

/**
 * Calendar sync (CAL-1): Google Calendar behind `GOOGLE_CALENDAR_PORT` (the HTTP adapter here, a fake in
 * tests), read through a personal mailbox's grant (`MailboxTokens`); the sync engine and its queue; the
 * subscriber that starts a first read and re-matches attendees when people change; and the routes that
 * read meetings, KPIs and a calendar's sync state. Slotline (CAL-2) — the workspace's booking site — posts its
 * bookings to a signed public hook, and they go through the same `MeetingStore`. New leads are written through the records module's
 * `PeopleService`, so they are created — and announced — as any person is.
 */
@Module({
    imports: [
        AuthModule,
        MailAccountsModule,
        RecordsModule,
        BullModule.registerQueue({
            name: CALENDAR_SYNC_QUEUE,
            defaultJobOptions: {
                attempts: CALENDAR_SYNC_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: CALENDAR_SYNC_JOB_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
    ],
    controllers: [MeetingsController, CalendarSyncController, SlotlineSettingsController, SlotlineHookController],
    providers: [
        { provide: GOOGLE_CALENDAR_PORT, useClass: GoogleCalendarHttp },
        MeetingStore,
        CalendarSyncService,
        CalendarSyncWorkers,
        CalendarSyncSubscriber,
        MeetingsService,
        LeadSuggestionsService,
        SlotlineSettingsService,
        SlotlineHookService,
    ],
})
export class CalendarModule {}
