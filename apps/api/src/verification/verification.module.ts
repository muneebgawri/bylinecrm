import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BylineApiModule } from '../byline/byline-api.module';
import { BylineVerifier } from '../byline/byline.verifier';
import { SendingPoolModule } from '../sending-pool/sending-pool.module';
import { EmailVerificationService } from './email-verification.service';
import { FreeVerifier } from './free-verifier';
import { PersonVerificationController, VerificationSettingsController } from './verification.controllers';
import { VERIFIER } from './verifier.port';

/**
 * Email verification (P3-5, FR-CRMS-14, FR-CRMS-16): the `Verifier` port with the free layer behind
 * it (syntax, MX through the sending pool's DNS port, disposable list, role detection — no SMTP
 * probe), the stored answers and how long they stand, and the two places they are read from — the
 * enrolment screen and the step runner (sequences) — through `EmailVerificationService.check`.
 */
@Module({
    imports: [AuthModule, SendingPoolModule, BylineApiModule],
    controllers: [VerificationSettingsController, PersonVerificationController],
    providers: [
        FreeVerifier,
        BylineVerifier,
        { provide: VERIFIER, useExisting: BylineVerifier },
        EmailVerificationService,
    ],
    exports: [EmailVerificationService],
})
export class VerificationModule {}
