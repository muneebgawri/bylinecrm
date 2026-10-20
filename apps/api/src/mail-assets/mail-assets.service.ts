import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
    MAIL_ASSET_PUBLIC_PATH,
    MAIL_IMAGE_MAX_BYTES,
    MAIL_IMAGE_MIME_TYPES,
    MAIL_IMAGE_STORED_WIDTH,
    type Capability,
    type MailAssetView,
} from '@bylinecrm/shared';
import type { MailAsset } from '@prisma/client';
import type { Request } from 'express';
import { randomToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { ApiException } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { FILE_STORAGE, FileNotInStorage, type FileStorage } from '../infra/storage/file-storage';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { readUpload } from '../records/multipart';
import { mailImage, UnreadableImage } from '../signatures/logo-image';

/** An image's token: 32 bytes, so its public address cannot be guessed. */
const TOKEN_BYTES = 32;
/** The public route's file name: `<token>.png` or `<token>.jpg`. */
const ASSET_FILE = /^([A-Za-z0-9_-]{32,64})\.(png|jpg)$/;
const EXTENSION: Record<MailAssetView['contentType'], 'png' | 'jpg'> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/**
 * What may upload a mail image: whoever writes mail — the composer (`email:send`), a template
 * (`template:write`) or a signature (`mailbox:manage`). Any one is enough.
 */
export const MAIL_ASSET_UPLOADERS: readonly Capability[] = ['email:send', 'template:write', 'mailbox:manage'];

export function mailAssetUrl(appUrl: string, asset: Pick<MailAsset, 'token' | 'contentType'>): string {
    const ext = EXTENSION[asset.contentType as MailAssetView['contentType']] ?? 'png';
    return `${appUrl.replace(/\/+$/, '')}${MAIL_ASSET_PUBLIC_PATH}/${asset.token}.${ext}`;
}

/**
 * Images in mail: a composed email's or a template's body, or a signature. The bytes go through the
 * workspace's file storage (as the signature logo's do), re-encoded and at most `MAIL_IMAGE_STORED_WIDTH`
 * wide, and are served publicly at an unguessable https address on `APP_URL`, so recipients' mail clients
 * show them with no sign-in. An image is never removed by an edit: mail already sent still links it.
 * Bytes go to storage before the row that records them, and are removed again if that row fails.
 */
@Injectable()
export class MailAssetsService {
    private readonly logger = new Logger(MailAssetsService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        // The public route has no workspace until the token names one: the owner client reads that one row.
        private readonly ownerPrisma: PrismaService,
        @Inject(FILE_STORAGE) private readonly storage: FileStorage,
        @Inject(ENV) private readonly env: Env,
    ) {}

    async upload(req: Request): Promise<MailAssetView> {
        const context = this.current();
        if (!MAIL_ASSET_UPLOADERS.some((c) => context.capabilities.has(c))) {
            throw new ApiException(
                403,
                'forbidden',
                'uploading a mail image needs email:send, template:write or mailbox:manage',
            );
        }
        const file = await readUpload(req, { maxBytes: MAIL_IMAGE_MAX_BYTES, mimeTypes: MAIL_IMAGE_MIME_TYPES });
        const bytes = await buffer(file.body);
        let image: ReturnType<typeof mailImage>;
        try {
            image = mailImage(bytes, MAIL_IMAGE_STORED_WIDTH);
        } catch (error) {
            if (!(error instanceof UnreadableImage)) throw error;
            throw new ApiException(422, 'unprocessable', `the file is not an image that can be read: ${error.message}`);
        }
        const storageKey = `${context.workspaceId}/mail-assets/${randomUUID()}`;
        await this.storage.put(storageKey, Readable.from(image.data));
        const asset = await this.rls
            .withWorkspace((tx) =>
                tx.mailAsset.create({
                    data: {
                        workspaceId: context.workspaceId,
                        token: randomToken(TOKEN_BYTES),
                        storageKey,
                        contentType: image.contentType,
                        width: image.width,
                        height: image.height,
                        sizeBytes: image.data.length,
                        uploadedById: context.memberId ?? null,
                    },
                }),
            )
            .catch(async (error: unknown) => {
                await this.storage.delete(storageKey);
                throw error;
            });
        return this.view(asset);
    }

    /** The bytes and type behind a public address; `404` for a token that is no image's. */
    async serve(file: string): Promise<{ body: Readable; contentType: string }> {
        const match = ASSET_FILE.exec(file);
        const asset = match ? await this.ownerPrisma.mailAsset.findUnique({ where: { token: match[1]! } }) : null;
        if (!asset || !match || EXTENSION[asset.contentType as MailAssetView['contentType']] !== match[2]) {
            throw new NotFoundException('image not found');
        }
        try {
            return { body: await this.storage.get(asset.storageKey), contentType: asset.contentType };
        } catch (error) {
            if (!(error instanceof FileNotInStorage)) throw error;
            this.logger.warn(`mail asset ${asset.id} has no bytes in storage`);
            throw new NotFoundException('image not found');
        }
    }

    private view(asset: MailAsset): MailAssetView {
        return {
            id: asset.id,
            url: mailAssetUrl(this.env.APP_URL, asset),
            width: asset.width,
            height: asset.height,
            contentType: asset.contentType as MailAssetView['contentType'],
            sizeBytes: asset.sizeBytes,
        };
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('MailAssetsService is used inside a workspace scope');
        return context;
    }
}
