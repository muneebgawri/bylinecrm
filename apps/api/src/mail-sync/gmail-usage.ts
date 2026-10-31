import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { AccountMail } from '../transactional-mail/account-mail';
import { GMAIL_DAILY_ALERT_UNITS, GMAIL_PROJECT_BILLED_UNITS_PER_DAY } from './mail-sync.constants';
import { GmailQuota, gmailQuotaDay } from './quota';

/**
 * Tells the platform admins when the project's Gmail spend for the day passes `GMAIL_DAILY_ALERT_UNITS` — half of
 * what Google bills above (PNW-1194). Asked on every mail-sync tick; the mail's idempotency key is the day and the
 * address, so the outbox keeps one per admin per day however many ticks see the day over the line.
 */
@Injectable()
export class GmailUsageAlert {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly quota: GmailQuota,
        private readonly mail: AccountMail,
    ) {}

    /** Whether the day is over the alert level (and the admins were told). */
    async check(now = new Date()): Promise<boolean> {
        const day = gmailQuotaDay(now);
        const units = await this.quota.dailyUnits(day);
        if (units < GMAIL_DAILY_ALERT_UNITS) return false;
        await this.ownerPrisma.$transaction(async (tx) => {
            for (const to of this.env.PLATFORM_ADMIN_EMAILS)
                await this.mail.gmailUsageHigh(tx, { to, day, units, billedAbove: GMAIL_PROJECT_BILLED_UNITS_PER_DAY });
        });
        this.mail.kick();
        return true;
    }
}
