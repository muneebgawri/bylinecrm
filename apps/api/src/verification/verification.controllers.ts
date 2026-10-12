import { Body, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { EmailVerificationSettingsView, EmailVerificationView, PersonVerificationView } from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { PutVerificationSettingsDto } from './dto';
import { EmailVerificationService } from './email-verification.service';
import { emailVerificationSettingsView, emailVerificationView, personVerificationView } from './responses';

/** How long a verification stands (FR-CRMS-16): read with outreach rights, set by an admin. */
@ApiTags('verification')
@TenantController('outreach')
export class VerificationSettingsController {
    constructor(private readonly verification: EmailVerificationService) {}

    @Requires('outreach:write')
    @Get('verification')
    @Returns(emailVerificationSettingsView)
    settings(): Promise<EmailVerificationSettingsView> {
        return this.verification.settings();
    }

    @Requires('workspace:admin')
    @Put('verification')
    @Returns(emailVerificationSettingsView)
    putSettings(@Body() body: PutVerificationSettingsDto): Promise<EmailVerificationSettingsView> {
        return this.verification.putSettings(body);
    }
}

/** A person's address as last verified, and verifying it again now (FR-CRMS-14). */
@ApiTags('verification')
@TenantController('people')
export class PersonVerificationController {
    constructor(private readonly verification: EmailVerificationService) {}

    @Requires('record:read')
    @Get(':personId/verification')
    @Returns(personVerificationView)
    read(@Param('personId', ParseUUIDPipe) personId: string): Promise<PersonVerificationView> {
        return this.verification.forPerson(personId);
    }

    @Requires('outreach:write')
    @HttpCode(200)
    @Post(':personId/verification')
    @Returns(emailVerificationView)
    verify(@Param('personId', ParseUUIDPipe) personId: string): Promise<EmailVerificationView> {
        return this.verification.verifyPerson(personId);
    }
}
