import {
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Req,
    Res,
    StreamableFile,
} from '@nestjs/common';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Requires } from '../auth/decorators';
import { AttachmentsService, type AttachmentView } from './attachments.service';
import { ListAttachmentsQueryDto, UploadAttachmentQueryDto } from './dto';
import { readUpload } from './multipart';
import { parseTarget } from './targets';

/** Files on a record. Reading one is reading the record; writing one is writing it. */
@ApiTags('attachments')
@Controller('w/:workspaceId/attachments')
export class AttachmentsController {
    constructor(private readonly attachments: AttachmentsService) {}

    @Requires('record:read')
    @Get()
    list(@Query() query: ListAttachmentsQueryDto): Promise<AttachmentView[]> {
        return this.attachments.list(parseTarget(query.target));
    }

    @Requires('record:write')
    @Get('deleted')
    listDeleted(@Query() query: ListAttachmentsQueryDto): Promise<AttachmentView[]> {
        return this.attachments.list(parseTarget(query.target), true);
    }

    @Requires('record:read')
    @Get(':attachmentId')
    get(@Param('attachmentId', ParseUUIDPipe) attachmentId: string): Promise<AttachmentView> {
        return this.attachments.get(attachmentId);
    }

    /** The bytes, as a download; never cached by a shared cache and never served from a public URL. */
    @Requires('record:read')
    @Get(':attachmentId/content')
    async content(
        @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<StreamableFile> {
        const { attachment, body } = await this.attachments.content(attachmentId);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return new StreamableFile(body, {
            type: attachment.mime,
            disposition: `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
            length: attachment.sizeBytes,
        });
    }

    /** `multipart/form-data` with one `file` field; `?target=<object>:<id>` says which record. */
    @Requires('record:write')
    @ApiConsumes('multipart/form-data')
    @Post()
    async upload(@Query() query: UploadAttachmentQueryDto, @Req() req: Request): Promise<AttachmentView> {
        const target = parseTarget(query.target);
        const file = await readUpload(req);
        return this.attachments.upload({ target, name: file.name, mime: file.mime, body: file.body });
    }

    @Requires('record:write')
    @HttpCode(204)
    @Delete(':attachmentId')
    remove(@Param('attachmentId', ParseUUIDPipe) attachmentId: string): Promise<void> {
        return this.attachments.remove(attachmentId);
    }

    @Requires('record:write')
    @Post(':attachmentId/restore')
    restore(@Param('attachmentId', ParseUUIDPipe) attachmentId: string): Promise<AttachmentView> {
        return this.attachments.restore(attachmentId);
    }
}
