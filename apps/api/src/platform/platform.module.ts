import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransactionalMailModule } from '../transactional-mail/transactional-mail.module';
import { PlatformAdminGuard, PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

/**
 * The platform (operator) routes, P0-14. `PlatformAccess` — who is a platform admin — is provided
 * once, by the auth module, because sign-up and `POST /workspaces` consult it too.
 */
@Module({
    imports: [AuthModule, TransactionalMailModule],
    controllers: [PlatformController],
    providers: [PlatformService, PlatformAdminGuard],
})
export class PlatformModule {}
