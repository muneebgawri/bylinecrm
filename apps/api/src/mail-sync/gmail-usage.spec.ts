import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env';
import type { PrismaService } from '../infra/prisma.service';
import { AccountMail } from '../transactional-mail/account-mail';
import type { MailOutbox } from '../transactional-mail/mail-outbox';
import { GmailUsageAlert } from './gmail-usage';
import { GMAIL_DAILY_ALERT_UNITS, GMAIL_PROJECT_BILLED_UNITS_PER_DAY } from './mail-sync.constants';
import type { GmailQuota } from './quota';

/**
 * PNW-1194: Google bills a project's Gmail use above 80M units a day (projects created since 2026-05-01). The project
 * is BylineCRM's OAuth client, so its spend is what the quota grants. The platform admins hear about it once a day,
 * when the day's total passes the alert level, well before Google's line.
 */
function setup(units: number) {
    const tx = { marker: 'tx' };
    const outbox = { record: vi.fn(() => Promise.resolve()), kick: vi.fn() };
    const env = {
        PLATFORM_ADMIN_EMAILS: ['ops@example.com', 'owner@example.com'],
        WEB_URL: 'https://crm.example.com',
    } as unknown as Env;
    const prisma = { $transaction: vi.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)) };
    const quota = { dailyUnits: vi.fn(() => Promise.resolve(units)) };
    const alert = new GmailUsageAlert(
        env,
        prisma as unknown as PrismaService,
        quota as unknown as GmailQuota,
        new AccountMail(env, outbox as unknown as MailOutbox),
    );
    return { alert, outbox, quota, tx };
}

describe('GmailUsageAlert', () => {
    it('R-PNW-1194b: the alert level is half of what Google bills above', () => {
        expect(GMAIL_DAILY_ALERT_UNITS).toBe(GMAIL_PROJECT_BILLED_UNITS_PER_DAY / 2);
    });

    it('R-PNW-1194b: below the alert level nobody is told', async () => {
        const { alert, outbox } = setup(GMAIL_DAILY_ALERT_UNITS - 1);
        expect(await alert.check(new Date('2026-10-31T18:00:00.000Z'))).toBe(false);
        expect(outbox.record).not.toHaveBeenCalled();
    });

    it('R-PNW-1194b: at the level each platform admin is told once for that day, however many ticks see it', async () => {
        const { alert, outbox, quota, tx } = setup(GMAIL_DAILY_ALERT_UNITS + 5);
        // 06:30 UTC on 1 November is still 31 October on Google's (Pacific) quota day.
        expect(await alert.check(new Date('2026-11-01T06:30:00.000Z'))).toBe(true);
        await alert.check(new Date('2026-11-01T06:32:00.000Z'));
        expect(quota.dailyUnits).toHaveBeenCalledWith('2026-10-31');
        const recorded = outbox.record.mock.calls.map((c) => c as unknown as [unknown, Record<string, string>]);
        expect(recorded.every(([t]) => t === tx)).toBe(true);
        expect(recorded.map(([, m]) => [m['kind'], m['to'], m['idempotencyKey']])).toEqual([
            ['gmail_usage_high', 'ops@example.com', 'gmail-usage-2026-10-31-ops@example.com'],
            ['gmail_usage_high', 'owner@example.com', 'gmail-usage-2026-10-31-owner@example.com'],
            // The second tick records the same keys: the outbox keeps one of each (skipDuplicates).
            ['gmail_usage_high', 'ops@example.com', 'gmail-usage-2026-10-31-ops@example.com'],
            ['gmail_usage_high', 'owner@example.com', 'gmail-usage-2026-10-31-owner@example.com'],
        ]);
        expect(recorded[0]![1]['text']).toContain('40,000,005');
        expect(recorded[0]![1]['text']).toContain('80,000,000');
        expect(outbox.kick).toHaveBeenCalled();
    });
});
