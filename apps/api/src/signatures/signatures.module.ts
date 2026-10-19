import { Module } from '@nestjs/common';
import { SlotlineApiHttp } from '../calendar/slotline/slotline-api.http';
import { SLOTLINE_API_PORT } from '../calendar/slotline/slotline-api.port';
import { MailSyncModule } from '../mail-sync/mail-sync.module';
import { LogosService } from './logos.service';
import {
    MailboxSignatureController,
    PublicLogoController,
    PublicSocialIconController,
    SignaturePreviewController,
    SignatureProfileController,
    SignatureSettingsController,
    SlotlineAccountController,
} from './signatures.controllers';
import { SlotlineAccountService } from './slotline-account.service';
import { SignaturesService } from './signatures.service';

/** Email signatures (#193): settings, mailboxes' signatures, member details, the public logo; a member's Slotline account (#196). */
@Module({
    imports: [MailSyncModule],
    controllers: [
        SignatureSettingsController,
        MailboxSignatureController,
        SignaturePreviewController,
        SignatureProfileController,
        SlotlineAccountController,
        PublicLogoController,
        PublicSocialIconController,
    ],
    // Slotline's v2 API (#196) is read only here, for a member's event types.
    providers: [
        SignaturesService,
        LogosService,
        SlotlineAccountService,
        { provide: SLOTLINE_API_PORT, useClass: SlotlineApiHttp },
    ],
    exports: [SignaturesService],
})
export class SignaturesModule {}
