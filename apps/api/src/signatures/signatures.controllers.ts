import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    Req,
    Res,
    StreamableFile,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type {
    ImportedSignature,
    MailboxSignatureView,
    RenderedSignature,
    SignatureProfileView,
    SignatureSettingsView,
    WorkspaceLogoView,
} from '@bylinecrm/shared';
import type { Request, Response } from 'express';
import { AnyMember, Public, Requires, TenantController } from '../auth/decorators';
import { Returns, ReturnsFile } from '../openapi/responses';
import { PreviewSignatureDto, PutMailboxSignatureDto, PutSignatureProfileDto, PutSignatureSettingsDto } from './dto';
import { LogosService } from './logos.service';
import {
    importedSignature,
    mailboxSignatureView,
    renderedSignature,
    signatureProfileView,
    signatureSettingsView,
    workspaceLogoView,
} from './responses';
import { SignaturesService } from './signatures.service';

/** The workspace's signature settings (#193): every member reads them; an admin sets the default, the locks and the logo. */
@ApiTags('mail')
@TenantController('settings/signatures')
export class SignatureSettingsController {
    constructor(
        private readonly signatures: SignaturesService,
        private readonly logos: LogosService,
    ) {}

    @Requires('record:read')
    @Get()
    @Returns(signatureSettingsView)
    get(): Promise<SignatureSettingsView> {
        return this.signatures.settings();
    }

    /** Replaces the default (or `null` for none) and the locks; a locked pre-fill must be in the default. */
    @Requires('workspace:admin')
    @Put()
    @Returns(signatureSettingsView)
    put(@Body() body: PutSignatureSettingsDto): Promise<SignatureSettingsView> {
        return this.signatures.putSettings(body);
    }

    /** `multipart/form-data` with one `file` field: PNG, JPEG or SVG, at most LOGO_MAX_BYTES; stored as a PNG. */
    @Requires('workspace:admin')
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        description:
            'One `file` part: PNG, JPEG or SVG, at most LOGO_MAX_BYTES. Stored as a PNG at most LOGO_WIDTH wide.',
        schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] },
    })
    @Post('logo')
    @Returns(workspaceLogoView)
    uploadLogo(@Req() req: Request): Promise<WorkspaceLogoView> {
        return this.logos.upload(req);
    }

    /** No logo from now on; its address answers for the grace period still, for mail already sent. */
    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete('logo')
    removeLogo(): Promise<void> {
        return this.logos.remove();
    }
}

/** A mailbox's signature (#193): its member's, or an admin's; a pool mailbox's an admin's. */
@ApiTags('mail')
@TenantController('mailboxes')
export class MailboxSignatureController {
    constructor(private readonly signatures: SignaturesService) {}

    @Requires('mailbox:read')
    @Get(':mailboxId/signature')
    @Returns(mailboxSignatureView)
    get(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<MailboxSignatureView> {
        return this.signatures.mailboxSignature(mailboxId);
    }

    @Requires('mailbox:manage')
    @Put(':mailboxId/signature')
    @Returns(mailboxSignatureView)
    put(
        @Param('mailboxId', ParseUUIDPipe) mailboxId: string,
        @Body() body: PutMailboxSignatureDto,
    ): Promise<MailboxSignatureView> {
        return this.signatures.putMailboxSignature(mailboxId, body);
    }

    /** The mailbox's Gmail signature, as a draft to save; nothing is saved. */
    @Requires('mailbox:manage')
    @HttpCode(200)
    @Post(':mailboxId/signature/import')
    @Returns(importedSignature)
    importFromGmail(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<ImportedSignature> {
        return this.signatures.importFromGmail(mailboxId);
    }
}

/** A signature as it would read in mail (#193). */
@ApiTags('mail')
@TenantController('signatures')
export class SignaturePreviewController {
    constructor(private readonly signatures: SignaturesService) {}

    @Requires('mailbox:read')
    @HttpCode(200)
    @Post('preview')
    @Returns(renderedSignature)
    preview(@Body() body: PreviewSignatureDto): Promise<RenderedSignature> {
        return this.signatures.preview(body);
    }
}

/** What a member's signature reads of them (#193): their title, phone and Slotline username. */
@ApiTags('mail')
@TenantController('members')
export class SignatureProfileController {
    constructor(private readonly signatures: SignaturesService) {}

    @AnyMember('a member’s own signature details; an admin’s for anyone — checked by the service')
    @Get(':memberId/signature-profile')
    @Returns(signatureProfileView)
    get(@Param('memberId', ParseUUIDPipe) memberId: string): Promise<SignatureProfileView> {
        return this.signatures.profile(memberId);
    }

    @AnyMember('a member’s own signature details; an admin’s for anyone — checked by the service')
    @Put(':memberId/signature-profile')
    @Returns(signatureProfileView)
    put(
        @Param('memberId', ParseUUIDPipe) memberId: string,
        @Body() body: PutSignatureProfileDto,
    ): Promise<SignatureProfileView> {
        return this.signatures.putProfile(memberId, body);
    }
}

/** The workspace logo, public (#193): mail clients load it with no sign-in; the token is the only key. */
@ApiTags('mail')
@Controller('public/logos')
@Public()
export class PublicLogoController {
    constructor(private readonly logos: LogosService) {}

    @Get(':file')
    @ReturnsFile('image/png')
    async serve(@Param('file') file: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
        const body = await this.logos.serve(file);
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return new StreamableFile(body, { type: 'image/png' });
    }
}
