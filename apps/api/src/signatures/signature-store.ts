import {
    LOGO_PUBLIC_PATH,
    SIGNATURE_LOCKABLE,
    SIGNATURE_LOCK_VARIABLE,
    type FieldError,
    type RenderedSignature,
    type RichText,
    type SignatureApplies,
    type SignatureLockable,
    type WorkspaceLogoView,
} from '@bylinecrm/shared';
import type { WorkspaceLogo } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { ApiException } from '../infra/errors/api-errors';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { renderSignature, signatureNames, type SignatureValues } from './render-signature';

/**
 * Reading signatures (#193), inside the caller's workspace transaction: which one a mailbox's mail
 * carries, what its variables read, and the logo. Plain functions over the transaction, so the
 * renderer and the signature routes read them the one same way.
 */

export interface StoredSignatureSettings {
    defaultSignature: RichText | null;
    locked: Record<SignatureLockable, boolean>;
}

/** Which signature follows a body (#193). */
export type SignatureChoice =
    /** The mailbox's: its own, else the workspace default unless the mailbox switched it off. */
    | { from: 'mailbox'; mailboxId: string }
    /** This message's, as the composer sent it — `null` for none — on the mailbox's values. */
    | { from: 'message'; mailboxId: string; signature: RichText | null }
    /** The workspace default: a template preview with no mailbox named. */
    | { from: 'default' };

/**
 * A mailbox whose signature the caller may read, change or preview (#193): their own personal mailbox, or
 * any as an admin — a pool mailbox's is an admin's. `404` for a mailbox not in the workspace.
 */
export async function signableMailbox(tx: WorkspaceClient, context: WorkspaceRunContext, mailboxId: string) {
    const mailbox = await tx.mailbox.findFirst({ where: { id: mailboxId } });
    if (!mailbox) throw new NotFoundException('mailbox not found');
    if (context.capabilities.has('workspace:admin')) return mailbox;
    if (mailbox.purpose === 'pool')
        throw new ApiException(403, 'forbidden', 'a pool mailbox’s signature is an admin’s');
    if (mailbox.ownerMemberId !== context.memberId) {
        throw new ApiException(403, 'forbidden', 'a mailbox’s signature is its member’s');
    }
    return mailbox;
}

export async function readSignatureSettings(tx: WorkspaceClient): Promise<StoredSignatureSettings> {
    const row = await tx.workspaceSignatureSettings.findFirst();
    return {
        defaultSignature: (row?.defaultSignature as RichText | null | undefined) ?? null,
        locked: { logo: row?.lockLogo ?? false, bookingLink: row?.lockBookingLink ?? false },
    };
}

export function effectiveSignature(
    mailbox: { signature: unknown; useDefaultSignature: boolean },
    settings: StoredSignatureSettings,
): { applies: SignatureApplies; effective: RichText | null } {
    const own = (mailbox.signature as RichText | null) ?? null;
    if (own) return { applies: 'own', effective: own };
    if (mailbox.useDefaultSignature && settings.defaultSignature) {
        return { applies: 'default', effective: settings.defaultSignature };
    }
    return { applies: 'none', effective: null };
}

/**
 * What an admin's locks ask of a signature (#193): every locked pre-fill in it, and a signature at all.
 * `at` is where the signature sits in the request.
 */
export function lockProblems(
    signature: RichText | null,
    locked: Record<SignatureLockable, boolean>,
    at: string,
): FieldError[] {
    const problems: FieldError[] = [];
    for (const lock of SIGNATURE_LOCKABLE) {
        if (!locked[lock]) continue;
        const path = SIGNATURE_LOCK_VARIABLE[lock];
        if (signature === null || !signatureNames(signature, path)) {
            problems.push({ path: at, message: `an admin has locked {{${path}}} into every signature` });
        }
    }
    return problems;
}

export async function currentLogo(tx: WorkspaceClient): Promise<WorkspaceLogo | null> {
    return tx.workspaceLogo.findFirst({ where: { retiredAt: null } });
}

export function logoUrl(appUrl: string, token: string): string {
    return `${appUrl.replace(/\/+$/, '')}${LOGO_PUBLIC_PATH}/${token}.png`;
}

export function logoView(appUrl: string, logo: WorkspaceLogo): WorkspaceLogoView {
    return {
        url: logoUrl(appUrl, logo.token),
        width: logo.width,
        height: logo.height,
        uploadedAt: logo.createdAt.toISOString(),
    };
}

/** The Slotline site's address, while Slotline is set up. */
export async function slotlineBase(tx: WorkspaceClient): Promise<string | null> {
    return (await tx.slotlineSettings.findFirst({ select: { baseUrl: true } }))?.baseUrl ?? null;
}

/** A member's booking page: `{baseUrl}/{username}`, or null without either. */
export function bookingLinkOf(base: string | null, username: string | null): string | null {
    return base && username ? `${base.replace(/\/+$/, '')}/${encodeURIComponent(username)}` : null;
}

/** Whether a link sits on the Slotline site (`base`, an https origin). */
export function onSlotline(base: string | null, link: string): boolean {
    if (!base) return false;
    try {
        const url = new URL(link);
        return url.protocol === 'https:' && url.origin === new URL(base).origin;
    } catch {
        return false;
    }
}

/**
 * What a signature's variables read for a send by `memberId`, from `mailbox` when one is named: the
 * member's name, title and phone; the booking link — a pool mailbox's own pick, else the member's page; the
 * workspace's name and current logo.
 */
export async function signatureValues(
    tx: WorkspaceClient,
    appUrl: string,
    input: { workspaceId: string; memberId: string | null | undefined; mailboxId?: string | undefined },
): Promise<SignatureValues> {
    const member = input.memberId
        ? await tx.workspaceMember.findFirst({
              where: { id: input.memberId },
              select: {
                  jobTitle: true,
                  phone: true,
                  slotlineUsername: true,
                  user: { select: { displayName: true } },
              },
          })
        : null;
    const mailbox = input.mailboxId
        ? await tx.mailbox.findFirst({ where: { id: input.mailboxId }, select: { purpose: true, bookingLink: true } })
        : null;
    const workspace = await tx.workspace.findUnique({ where: { id: input.workspaceId }, select: { name: true } });
    const logo = await currentLogo(tx);
    const base = await slotlineBase(tx);
    const fullName = member?.user.displayName?.trim() || null;
    return {
        sender: {
            fullName,
            firstName: fullName?.split(/\s+/)[0] ?? null,
            title: member?.jobTitle ?? null,
            phone: member?.phone ?? null,
            bookingLink:
                mailbox?.purpose === 'pool'
                    ? mailbox.bookingLink
                    : bookingLinkOf(base, member?.slotlineUsername ?? null),
        },
        workspace: {
            name: workspace?.name ?? '',
            logo: logo ? { url: logoUrl(appUrl, logo.token), width: logo.width, height: logo.height } : null,
        },
    };
}

/** The signature a choice names, rendered for the sending member; null when there is none, or it renders empty. */
export async function renderChoice(
    tx: WorkspaceClient,
    appUrl: string,
    choice: SignatureChoice,
    sender: { workspaceId: string; memberId: string | null | undefined },
): Promise<RenderedSignature | null> {
    let signature: RichText | null;
    if (choice.from === 'message') {
        signature = choice.signature;
    } else if (choice.from === 'default') {
        signature = (await readSignatureSettings(tx)).defaultSignature;
    } else {
        const mailbox = await tx.mailbox.findFirstOrThrow({
            where: { id: choice.mailboxId },
            select: { signature: true, useDefaultSignature: true },
        });
        signature = effectiveSignature(mailbox, await readSignatureSettings(tx)).effective;
    }
    if (!signature) return null;
    const values = await signatureValues(tx, appUrl, {
        ...sender,
        ...(choice.from === 'default' ? {} : { mailboxId: choice.mailboxId }),
    });
    const rendered = renderSignature(signature, values);
    return rendered.html === '' && rendered.text === '' ? null : rendered;
}
