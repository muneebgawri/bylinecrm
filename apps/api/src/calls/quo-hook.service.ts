import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CallRecording, CallSummaryText, CallTranscriptLine } from '@bylinecrm/shared';
import { CALL_MATCH_WINDOW_MS } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { RateLimiter } from '../auth/rate-limiter.service';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, RateLimited } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { directionOf, outsideNumber, ownNumber, phonesPattern, statusOf } from './call-rules';
import { QUO_HOOK_FAILURE_LIMIT, QUO_HOOK_FAILURE_WINDOW_S, QUO_IGNORED, quoHookRateKey } from './calls.constants';
import { callEvent } from './calls.service';
import { verifyQuoSignature } from './quo-signature';
import { QUO_API, type QuoApi, type QuoCall } from './quo.port';

export type QuoHookResult = 'recorded' | 'updated' | 'ignored' | 'unknown_call' | 'bad_signature';

/** A delivery's envelope, as far as the receiver reads it: the event's type and the call it is about. */
interface Envelope {
    type: string;
    callId: string | null;
}

/**
 * Quo's webhook for a workspace (CALL-1): the URL names the workspace, the Svix-style signature with the webhook's
 * key proves the sender, and the event names a call — which is then read whole from Quo's API (the delivery
 * carries no participants), so every event, in any order, brings the row up to date: the call itself, its
 * recording, its voicemail, its AI summary, its transcript. The person is the outside number's; the member is
 * the Quo user's. A call a member logged by hand just before is the same row, claimed. A redelivery changes
 * nothing it already has.
 */
@Injectable()
export class QuoHookService {
    private readonly logger = new Logger(QuoHookService.name);

    constructor(
        @Inject(QUO_API) private readonly quo: QuoApi,
        private readonly owner: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly secrets: SecretBox,
        private readonly events: DomainEvents,
        private readonly limiter: RateLimiter,
    ) {}

    async receive(
        workspaceId: string,
        headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
        rawBody: Buffer | undefined,
        body: unknown,
        clientIp: string,
    ): Promise<QuoHookResult> {
        const settings = await this.owner.quoSettings.findUnique({ where: { workspaceId } });
        if (!settings?.webhookSecretCiphertext) {
            await this.refused(clientIp);
            throw new ApiException(404, 'not_found', 'no Quo link for this workspace');
        }
        const secret = this.secrets.open(settings.webhookSecretCiphertext);
        if (!verifyQuoSignature({ secret, ...headers, rawBody })) {
            await this.refused(clientIp);
            await this.record(workspaceId, 'bad_signature');
            throw new ApiException(401, 'unauthorized', 'the delivery was not signed with this webhook’s key');
        }
        const envelope = readEnvelope(body);
        if (!envelope || !envelope.type.startsWith('call.') || !envelope.callId) {
            await this.record(workspaceId, QUO_IGNORED);
            return 'ignored';
        }
        const apiKey = this.secrets.open(settings.apiKeyCiphertext);
        const call = await this.quo.getCall(apiKey, envelope.callId);
        if (!call) {
            await this.record(workspaceId, 'unknown_call');
            return 'unknown_call';
        }
        // Recordings and transcripts live behind their own endpoints; asked only when the event says they exist.
        const recordings =
            envelope.type === 'call.recording.completed' ? await this.quo.listRecordings(apiKey, call.id) : null;
        const transcripts =
            envelope.type === 'call.transcript.completed' ? await this.quo.listTranscripts(apiKey, call.id) : null;
        const result = await this.rls.withWorkspace(workspaceId, (tx) =>
            this.apply(tx, workspaceId, call, recordings, transcripts, envelope.type),
        );
        await this.record(workspaceId, result);
        return result;
    }

    private async apply(
        tx: WorkspaceClient,
        workspaceId: string,
        call: QuoCall,
        recordings: { url: string; duration: number | null }[] | null,
        transcripts: { dialogue: { userId: string | null; content: string; start: number; end: number }[] }[] | null,
        eventType: string,
    ): Promise<QuoHookResult> {
        const outside = outsideNumber(call);
        const own = ownNumber(call);
        const direction = directionOf(call);
        const member = call.actorId
            ? await tx.workspaceMember.findFirst({ where: { quoUserId: call.actorId }, select: { id: true } })
            : null;
        const personId = outside ? await this.personByNumber(tx, outside) : null;
        const startedAt = new Date(call.createdAt);
        const recordingRows: CallRecording[] | undefined = recordings
            ? recordings.map((r) => ({ url: r.url, durationSec: r.duration }))
            : call.voicemail?.recordingUrl
              ? [{ url: call.voicemail.recordingUrl, durationSec: call.voicemail.duration }]
              : undefined;
        const summary: CallSummaryText | undefined =
            call.summary && (call.summary.summary?.length || call.summary.nextSteps?.length)
                ? { summary: call.summary.summary ?? [], nextSteps: call.summary.nextSteps ?? [] }
                : undefined;
        const transcript: CallTranscriptLine[] | undefined = transcripts?.length
            ? transcripts.flatMap((t) =>
                  t.dialogue.map((l) => ({ speakerUserId: l.userId, text: l.content, start: l.start, end: l.end })),
              )
            : undefined;
        const fields = {
            memberId: member?.id ?? null,
            personId,
            direction,
            status: statusOf(call),
            fromNumber: direction === 'outbound' ? own : outside,
            toNumber: direction === 'outbound' ? outside : own,
            startedAt,
            answeredAt: call.answeredAt ? new Date(call.answeredAt) : null,
            completedAt: call.completedAt ? new Date(call.completedAt) : null,
            durationSec: call.duration,
            hasVoicemail: !!call.voicemail?.recordingUrl,
            ...(recordingRows ? { recordings: recordingRows as unknown as Prisma.InputJsonValue } : {}),
            ...(summary ? { summary: summary as unknown as Prisma.InputJsonValue } : {}),
            ...(transcript ? { transcript: transcript as unknown as Prisma.InputJsonValue } : {}),
        };
        const context = {
            workspaceId,
            ...(member ? { memberId: member.id } : {}),
            ...(member ? {} : { actor: { kind: 'sync' as const, id: null } }),
        };

        const existing = await tx.call.findUnique({
            where: { workspaceId_provider_externalId: { workspaceId, provider: 'quo', externalId: call.id } },
        });
        if (existing) {
            // Quo's later word on the call; the member's own disposition and note are theirs and stay.
            const row = await tx.call.update({
                where: { id: existing.id },
                data: { ...fields, personId: existing.personId ?? personId },
            });
            await this.events.record(tx, callEvent('call.updated', context, row));
            return 'updated';
        }
        // A call the member logged from the panel just before Quo reported it: the same call, claimed.
        const logged = personId
            ? await tx.call.findFirst({
                  where: {
                      provider: 'manual',
                      externalId: null,
                      personId,
                      direction,
                      startedAt: {
                          gte: new Date(startedAt.getTime() - CALL_MATCH_WINDOW_MS),
                          lte: new Date(startedAt.getTime() + CALL_MATCH_WINDOW_MS),
                      },
                  },
                  orderBy: { startedAt: 'desc' },
              })
            : null;
        if (logged) {
            const row = await tx.call.update({
                where: { id: logged.id },
                data: { ...fields, provider: 'quo', externalId: call.id, memberId: logged.memberId ?? fields.memberId },
            });
            await this.events.record(tx, callEvent('call.updated', context, row));
            return 'updated';
        }
        const row = await tx.call.create({ data: { ...fields, workspaceId, provider: 'quo', externalId: call.id } });
        this.logger.log(`quo ${eventType}: recorded call ${call.id} for workspace ${workspaceId}`);
        await this.events.record(tx, callEvent('call.logged', context, row));
        return 'recorded';
    }

    /** The one live person whose stored phones end in the number's digits; none when several do (never a guess). */
    private async personByNumber(tx: WorkspaceClient, e164: string): Promise<string | null> {
        const pattern = phonesPattern(e164);
        if (!pattern) return null;
        const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM people WHERE deleted_at IS NULL AND phones::text ~ ${pattern} LIMIT 2`;
        return rows.length === 1 ? rows[0]!.id : null;
    }

    private async record(workspaceId: string, result: string): Promise<void> {
        await this.owner.quoSettings.updateMany({
            where: { workspaceId },
            data: { lastDeliveryAt: new Date(), lastDeliveryResult: result },
        });
    }

    private async refused(clientIp: string): Promise<void> {
        const over = await this.limiter.hit(
            quoHookRateKey(clientIp),
            QUO_HOOK_FAILURE_LIMIT,
            QUO_HOOK_FAILURE_WINDOW_S,
        );
        if (over) throw new RateLimited('too many refused deliveries; try again later');
    }
}

/** The event's type and the call it names: `data.resource.id` for a call event, `data.resource.callId` for what follows one. */
export function readEnvelope(body: unknown): Envelope | null {
    if (typeof body !== 'object' || body === null) return null;
    const b = body as Record<string, unknown>;
    const type = typeof b['type'] === 'string' ? b['type'] : null;
    if (!type) return null;
    const data = typeof b['data'] === 'object' && b['data'] !== null ? (b['data'] as Record<string, unknown>) : {};
    const resource =
        typeof data['resource'] === 'object' && data['resource'] !== null
            ? (data['resource'] as Record<string, unknown>)
            : {};
    const callId =
        typeof resource['callId'] === 'string'
            ? resource['callId']
            : typeof resource['id'] === 'string' && resource['id'].startsWith('AC')
              ? resource['id']
              : null;
    return { type, callId };
}
