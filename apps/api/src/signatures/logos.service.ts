import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { LOGO_GRACE_DAYS, LOGO_MAX_BYTES, LOGO_MIME_TYPES, type WorkspaceLogoView } from '@bylinecrm/shared';
import type { Request } from 'express';
import { randomToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { ApiException } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { FILE_STORAGE, FileNotInStorage, type FileStorage } from '../infra/storage/file-storage';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { readUpload } from '../records/multipart';
import { logoPng, UnreadableImage } from './logo-image';
import { logoView } from './signature-store';

/** A logo's token: 32 bytes, so its public address cannot be guessed. */
const LOGO_TOKEN_BYTES = 32;
const GRACE_MS = LOGO_GRACE_DAYS * 86_400_000;
/** The public route's file name: `<token>.png`. */
const LOGO_FILE = /^([A-Za-z0-9_-]{32,64})\.png$/;

/**
 * The workspace logo (#193): uploaded once by an admin, stored as a PNG at most `LOGO_WIDTH` wide (`logo-image.ts`), and
 * served publicly at an unguessable address so recipients' mail clients show it with no sign-in. A new
 * logo gets a new address; the one it replaced keeps answering for `LOGO_GRACE_DAYS`, for mail already
 * sent, and its bytes are removed with the next upload after that. Bytes go to storage before the
 * transaction that records them, and are removed after the one that forgets them.
 */
@Injectable()
export class LogosService {
    private readonly logger = new Logger(LogosService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        // The public route has no workspace until the token names one: the owner client reads that one
        // row by its token, as the unsubscribe page does.
        private readonly ownerPrisma: PrismaService,
        @Inject(FILE_STORAGE) private readonly storage: FileStorage,
        @Inject(ENV) private readonly env: Env,
    ) {}

    async upload(req: Request): Promise<WorkspaceLogoView> {
        const context = this.current();
        const file = await readUpload(req, { maxBytes: LOGO_MAX_BYTES, mimeTypes: LOGO_MIME_TYPES });
        const bytes = await buffer(file.body);
        let png: ReturnType<typeof logoPng>;
        try {
            png = logoPng(bytes);
        } catch (error) {
            if (!(error instanceof UnreadableImage)) throw error;
            throw new ApiException(422, 'unprocessable', `the file is not a logo that can be read: ${error.message}`);
        }
        const storageKey = `${context.workspaceId}/logos/${randomUUID()}`;
        await this.storage.put(storageKey, Readable.from(png.data));
        const now = new Date();
        const recorded = this.rls.withWorkspace(async (tx) => {
            await tx.workspaceLogo.updateMany({ where: { retiredAt: null }, data: { retiredAt: now } });
            const old = await tx.workspaceLogo.findMany({
                where: { retiredAt: { lt: new Date(now.getTime() - GRACE_MS) } },
                select: { id: true, storageKey: true },
            });
            await tx.workspaceLogo.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
            const created = await tx.workspaceLogo.create({
                data: {
                    workspaceId: context.workspaceId,
                    token: randomToken(LOGO_TOKEN_BYTES),
                    storageKey,
                    width: png.width,
                    height: png.height,
                    sizeBytes: png.data.length,
                    uploadedById: context.memberId ?? null,
                },
            });
            return { logo: created, expired: old };
        });
        const { logo, expired } = await recorded.catch(async (error: unknown) => {
            await this.storage.delete(storageKey);
            throw error;
        });
        for (const gone of expired) await this.storage.delete(gone.storageKey);
        return logoView(this.env.APP_URL, logo);
    }

    /** No logo from now on; the current address answers for the grace period still. */
    async remove(): Promise<void> {
        this.current();
        await this.rls.withWorkspace((tx) =>
            tx.workspaceLogo.updateMany({ where: { retiredAt: null }, data: { retiredAt: new Date() } }),
        );
    }

    /** The bytes behind a public logo address; `404` for a token that is no logo's, or one past its grace period. */
    async serve(file: string): Promise<Readable> {
        const token = LOGO_FILE.exec(file)?.[1];
        const logo = token ? await this.ownerPrisma.workspaceLogo.findUnique({ where: { token } }) : null;
        if (!logo || (logo.retiredAt && logo.retiredAt.getTime() < Date.now() - GRACE_MS)) {
            throw new NotFoundException('logo not found');
        }
        try {
            return await this.storage.get(logo.storageKey);
        } catch (error) {
            if (!(error instanceof FileNotInStorage)) throw error;
            this.logger.warn(`logo ${logo.id} has no bytes in storage`);
            throw new NotFoundException('logo not found');
        }
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('LogosService is used inside a workspace scope');
        return context;
    }
}
