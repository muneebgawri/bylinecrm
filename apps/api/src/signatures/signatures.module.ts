import { Module } from '@nestjs/common';
import { MailSyncModule } from '../mail-sync/mail-sync.module';
import { LogosService } from './logos.service';
import {
    MailboxSignatureController,
    PublicLogoController,
    SignaturePreviewController,
    SignatureProfileController,
    SignatureSettingsController,
} from './signatures.controllers';
import { SignaturesService } from './signatures.service';

/** Email signatures (#193): settings, mailboxes' signatures, member details, the public logo. */
@Module({
    imports: [MailSyncModule],
    controllers: [
        SignatureSettingsController,
        MailboxSignatureController,
        SignaturePreviewController,
        SignatureProfileController,
        PublicLogoController,
    ],
    providers: [SignaturesService, LogosService],
    exports: [SignaturesService],
})
export class SignaturesModule {}
