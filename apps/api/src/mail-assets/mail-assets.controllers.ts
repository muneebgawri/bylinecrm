import { Controller, Get, Param, Post, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { MAIL_ASSET_PUBLIC_PATH, MAIL_IMAGE_MAX_BYTES, type MailAssetView } from '@bylinecrm/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AnyMember, Public, TenantController } from '../auth/decorators';
import { id, named, Returns, ReturnsFile } from '../openapi/responses';
import { MailAssetsService } from './mail-assets.service';

const mailAssetView = named(
    'MailAsset',
    z.object({
        id,
        url: z.string().meta({ description: 'Public, https and unguessable; mail clients load it without a sign-in.' }),
        width: z.number().int(),
        height: z.number().int(),
        contentType: z.enum(['image/png', 'image/jpeg']),
        sizeBytes: z.number().int(),
    }),
);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** Compile-time only: the shared type and its schema describe the same values. */
export type MailAssetTypeChecks = [Assert<Same<z.output<typeof mailAssetView>, MailAssetView>>];

/** Images for mail: a composed email's or a template's body, or a signature. */
@ApiTags('mail')
@TenantController('mail-assets')
export class MailAssetsController {
    constructor(private readonly assets: MailAssetsService) {}

    /** `multipart/form-data` with one `file` field: PNG or JPEG, at most MAIL_IMAGE_MAX_BYTES. */
    @AnyMember('whoever writes mail — email:send, template:write or mailbox:manage; checked by the service')
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        description: `One \`file\` part: PNG or JPEG, at most ${MAIL_IMAGE_MAX_BYTES} bytes. Stored re-encoded, at most MAIL_IMAGE_STORED_WIDTH wide.`,
        schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] },
    })
    @Post()
    @Returns(mailAssetView)
    upload(@Req() req: Request): Promise<MailAssetView> {
        return this.assets.upload(req);
    }
}

/** A mail image, public: mail clients load it with no sign-in; the token is the only key. */
@ApiTags('mail')
@Controller(MAIL_ASSET_PUBLIC_PATH.replace(/^\/api\//, ''))
@Public()
export class PublicMailAssetController {
    constructor(private readonly assets: MailAssetsService) {}

    @Get(':file')
    @ReturnsFile('image/*')
    async serve(@Param('file') file: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
        const { body, contentType } = await this.assets.serve(file);
        // An address never changes what it shows: cached for a year.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return new StreamableFile(body, { type: contentType });
    }
}
