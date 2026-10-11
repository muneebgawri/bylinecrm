import { Logger } from '@nestjs/common';
import { MEMORY_OUTBOX_CAPACITY } from './transactional-mail.constants';
import type { MailKind, OutgoingMail, TransactionalMailTransport } from './transport.port';

/** A message the memory transport accepted. */
export interface SentMail extends OutgoingMail {
    id: string;
    kind: MailKind;
    sentAt: Date;
}

/**
 * The in-process outbox: what the memory transport "sent", newest last, at most
 * `MEMORY_OUTBOX_CAPACITY`. Process-wide, because a process may hold more than one application (the
 * test suite) and the mail is the process's, not one module instance's. Like Resend, a second
 * message with an idempotency key already seen is accepted and not stored again.
 */
class MemoryOutbox {
    private readonly sent: SentMail[] = [];

    record(mail: OutgoingMail): SentMail {
        const existing = this.sent.find((m) => m.idempotencyKey === mail.idempotencyKey);
        if (existing) return existing;
        const stored: SentMail = { ...mail, id: `memory-${mail.idempotencyKey}`, sentAt: new Date() };
        this.sent.push(stored);
        if (this.sent.length > MEMORY_OUTBOX_CAPACITY) this.sent.shift();
        return stored;
    }

    messages(): readonly SentMail[] {
        return this.sent;
    }
}

export const memoryOutbox = new MemoryOutbox();

/**
 * Where transactional mail goes when no Resend key is configured — development and CI (#93). It
 * stores the message in `memoryOutbox` and logs one line. Outside production the line carries the
 * text part (so a developer can follow a verification link); production never runs this transport,
 * because boot refuses production without a key.
 */
export class MemoryTransport implements TransactionalMailTransport {
    private readonly logger = new Logger('TransactionalMail');

    constructor(private readonly logBodies: boolean) {}

    send(mail: OutgoingMail): Promise<{ id: string }> {
        const stored = memoryOutbox.record(mail);
        const head = `${mail.kind} to ${mail.to}: "${mail.subject}" (not sent: no RESEND_API_KEY)`;
        this.logger.log(this.logBodies ? `${head}\n${mail.text}` : head);
        return Promise.resolve({ id: stored.id });
    }
}
