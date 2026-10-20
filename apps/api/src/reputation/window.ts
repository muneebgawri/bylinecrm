import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { fingerprint } from './fingerprint';
import type { WindowEntry } from './judge';

const NO_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Every message that started a thread from this mailbox since `since`, outside a sequence (REP-1): what the
 * CRM sent or is sending (`mail_outbound`, queued or later, not a reply, not a sequence's step) and what
 * Gmail sync saw leave the mailbox that the CRM did not send (a stored outbound copy with no
 * `In-Reply-To`). Recipients who are workspace members are not counted for synced mail. A synced message
 * not fingerprinted yet is fingerprinted here, once (its two derived columns are the only ones the app
 * may update). `exceptOutboundId`: the send being judged.
 */
export async function newThreadMail(
    tx: WorkspaceClient,
    mailboxId: string,
    since: Date,
    exceptOutboundId?: string,
): Promise<WindowEntry[]> {
    const crm = await tx.$queryRaw<
        {
            addresses: string[];
            body_simhash: bigint | null;
            subject_key: string | null;
            at: Date;
        }[]
    >`
        SELECT to_addresses || cc_addresses || bcc_addresses AS addresses, body_simhash, subject_key,
               coalesce(sent_at, last_attempt_at, created_at) AS at
        FROM mail_outbound
        WHERE mailbox_id = ${mailboxId}::uuid
          AND reply_to_message_id IS NULL
          AND sequence_enrolment_id IS NULL
          AND status IN ('queued', 'sending', 'sent')
          AND coalesce(sent_at, last_attempt_at, created_at) >= ${since}
          AND id <> ${exceptOutboundId ?? NO_ID}::uuid`;
    const synced = await tx.$queryRaw<
        {
            id: string;
            subject: string;
            body_text: string;
            body_simhash: bigint | null;
            subject_key: string | null;
            sent_at: Date;
            addresses: string[];
        }[]
    >`
        SELECT m.id, m.subject, m.body_text, m.body_simhash, m.subject_key, m.sent_at,
               ARRAY(SELECT DISTINCT lower(p.address) FROM mail_participants p
                     WHERE p.message_id = m.id AND p.role IN ('to', 'cc', 'bcc') AND p.member_id IS NULL) AS addresses
        FROM mail_messages m
        JOIN mail_message_copies c ON c.message_id = m.id AND c.mailbox_id = ${mailboxId}::uuid AND c.direction = 'outbound'
        WHERE m.sent_at >= ${since}
          AND m.in_reply_to IS NULL
          AND NOT EXISTS (SELECT 1 FROM mail_outbound o WHERE o.mail_message_id = m.id)`;

    const entries: WindowEntry[] = crm.map((r) => ({
        addresses: r.addresses.map((a) => a.toLowerCase()),
        simhash: r.body_simhash,
        subjectKey: r.subject_key,
        at: r.at,
    }));
    for (const r of synced) {
        let simhash = r.body_simhash;
        let subjectKey = r.subject_key;
        if (subjectKey === null) {
            const f = fingerprint(r.subject, r.body_text);
            simhash = f.simhash;
            subjectKey = f.subjectKey;
            await tx.mailMessage.updateMany({
                where: { id: r.id },
                data: { bodySimhash: simhash, subjectKey },
            });
        }
        if (r.addresses.length === 0) continue;
        entries.push({ addresses: r.addresses, simhash, subjectKey, at: r.sent_at });
    }
    return entries;
}
