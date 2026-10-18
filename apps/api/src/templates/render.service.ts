import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EmailTemplateBody, Emails } from '@bylinecrm/shared';
import { ENV, type Env } from '../config/env';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { recordWhere } from '../records/record-scope';
import { renderChoice, type SignatureChoice } from '../signatures/signature-store';
import { readMailSettings } from './mail-settings.service';
import { composeEmail, type ComposedEmail } from './render/compose';
import { resolverFor, type RenderSubjects } from './render/variables';

/** Whom a render is for: the recipient, the deal it is about (if any), and the member sending. */
export interface RenderTarget {
    personId: string;
    dealId?: string | undefined;
    /** Absent for a caller who is not a member (an API key): the `sender.*` variables are then missing. */
    senderMemberId?: string | undefined;
    /** The signature that follows the body (#193); absent, none does. */
    signature?: SignatureChoice | undefined;
}

/**
 * The one place a template becomes an email (P2-4): preview today, the send path (P2-3) and
 * sequences (P3) later. It reads the recipient, their company, the deal and the sender under the
 * caller's policies — a person or deal the caller cannot see is `404`, exactly as reading it would
 * be — and composes the email from them, the workspace's mail settings and the signature (#193).
 */
@Injectable()
export class RenderService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        @Inject(ENV) private readonly env: Env,
    ) {}

    render(
        template: Pick<EmailTemplateBody, 'kind' | 'subject' | 'body'>,
        target: RenderTarget,
    ): Promise<ComposedEmail> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const subjects = await loadSubjects(tx, context, target);
            const settings = await readMailSettings(tx);
            const signature = target.signature
                ? await renderChoice(tx, this.env.APP_URL, target.signature, {
                      workspaceId: context.workspaceId,
                      memberId: target.senderMemberId,
                  })
                : null;
            return composeEmail(template, resolverFor(subjects), settings, signature);
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('RenderService is used inside a workspace scope');
        return context;
    }
}

const customOf = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function loadSubjects(
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
    target: RenderTarget,
): Promise<RenderSubjects> {
    const scope = recordWhere(context, false);
    const person = await tx.person.findFirst({ where: { id: target.personId, ...scope } });
    if (!person) throw new NotFoundException('person not found');
    const deal = target.dealId ? await tx.opportunity.findFirst({ where: { id: target.dealId, ...scope } }) : null;
    if (target.dealId && !deal) throw new NotFoundException('deal not found');
    // The person's company, if the caller can see it; one they cannot is simply not there.
    const company = person.companyId ? await tx.company.findFirst({ where: { id: person.companyId, ...scope } }) : null;
    const sender = target.senderMemberId
        ? await tx.workspaceMember.findFirst({
              where: { id: target.senderMemberId },
              select: { user: { select: { displayName: true } } },
          })
        : null;
    return {
        person: {
            nameFirst: person.nameFirst,
            nameLast: person.nameLast,
            emails: person.emails as unknown as Emails,
            jobTitle: person.jobTitle,
            city: person.city,
            custom: customOf(person.custom),
        },
        company: company ? { name: company.name, domain: company.domain, custom: customOf(company.custom) } : null,
        deal: deal
            ? {
                  name: deal.name,
                  amountMinor: deal.amountMinor === null ? null : Number(deal.amountMinor),
                  currency: deal.currency,
                  custom: customOf(deal.custom),
              }
            : null,
        sender: sender ? { displayName: sender.user.displayName } : null,
    };
}
