import {
    NotFoundException,
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
    SlotlineEventTypeView,
    WorkspaceLogoView,
} from '@bylinecrm/shared';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { SOCIAL_ICON_PATH, SOCIAL_NETWORKS } from '@bylinecrm/shared';
import { AnyMember, Public, Requires, TenantController } from '../auth/decorators';
import { Returns, ReturnsFile } from '../openapi/responses';
import {
    PreviewSignatureDto,
    PutMailboxSignatureDto,
    PutSignatureProfileDto,
    PutSignatureSettingsDto,
    PutSlotlineEventDto,
    PutSlotlineKeyDto,
} from './dto';
import { LogosService } from './logos.service';
import {
    importedSignature,
    mailboxSignatureView,
    renderedSignature,
    signatureProfileView,
    signatureSettingsView,
    slotlineEventTypeView,
    workspaceLogoView,
} from './responses';
import { SignaturesService } from './signatures.service';
import { SlotlineAccountService } from './slotline-account.service';

/** The icons, as files beside the build: `apps/api/assets/social-icons/<network>.png` (made by `scripts/social-icons.mjs`). */
const SOCIAL_ICON_DIR = join(__dirname, '..', '..', 'assets', 'social-icons');

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

    /** `multipart/form-data` with one `file` field: PNG or JPEG, at most LOGO_MAX_BYTES; stored as a PNG. */
    @Requires('workspace:admin')
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        description: 'One `file` part: PNG or JPEG, at most LOGO_MAX_BYTES. Stored as a PNG at most LOGO_WIDTH wide.',
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

    /** Every current member's details, by name: an admin sets a member's booking link from it. */
    @Requires('workspace:admin')
    @Get('signature-profiles')
    @Returns([signatureProfileView])
    list(): Promise<SignatureProfileView[]> {
        return this.signatures.profiles();
    }

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

/** A member's own Slotline account (#196): their key, their event types, the one their booking link opens. */
@ApiTags('mail')
@TenantController('members')
export class SlotlineAccountController {
    constructor(private readonly accounts: SlotlineAccountService) {}

    /** Checked with Slotline before it is kept; the username becomes Slotline's. `422` for a key Slotline refuses. */
    @AnyMember('a member’s own Slotline account — the service refuses anyone else')
    @Put(':memberId/slotline-key')
    @Returns(signatureProfileView)
    putKey(
        @Param('memberId', ParseUUIDPipe) memberId: string,
        @Body() body: PutSlotlineKeyDto,
    ): Promise<SignatureProfileView> {
        return this.accounts.putKey(memberId, body.apiKey);
    }

    @AnyMember('a member’s own Slotline account — the service refuses anyone else')
    @HttpCode(204)
    @Delete(':memberId/slotline-key')
    removeKey(@Param('memberId', ParseUUIDPipe) memberId: string): Promise<void> {
        return this.accounts.removeKey(memberId);
    }

    /** Every event type on the account, hidden ones too. `409` without a key, or when Slotline does not answer. */
    @AnyMember('a member’s own Slotline account — the service refuses anyone else')
    @Get(':memberId/slotline/event-types')
    @Returns([slotlineEventTypeView])
    eventTypes(@Param('memberId', ParseUUIDPipe) memberId: string): Promise<SlotlineEventTypeView[]> {
        return this.accounts.eventTypes(memberId);
    }

    @AnyMember('a member’s own Slotline account — the service refuses anyone else')
    @Put(':memberId/slotline-event')
    @Returns(signatureProfileView)
    pickEvent(
        @Param('memberId', ParseUUIDPipe) memberId: string,
        @Body() body: PutSlotlineEventDto,
    ): Promise<SignatureProfileView> {
        return this.accounts.pickEvent(memberId, body.slug);
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

/** The social icons signatures link (#193), public: mail clients load them with no sign-in. */
@ApiTags('mail')
@Controller(SOCIAL_ICON_PATH.replace(/^\/api\//, ''))
@Public()
export class PublicSocialIconController {
    @Get(':file')
    @ReturnsFile('image/png')
    serve(@Param('file') file: string, @Res({ passthrough: true }) res: Response): StreamableFile {
        const network = SOCIAL_NETWORKS.find((n) => file === `${n}.png`);
        if (!network) throw new NotFoundException('no such icon');
        // The path is versioned (`/v1`): an icon that changes gets a new path, so this one is cached for good.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return new StreamableFile(createReadStream(join(SOCIAL_ICON_DIR, `${network}.png`)), { type: 'image/png' });
    }
}
