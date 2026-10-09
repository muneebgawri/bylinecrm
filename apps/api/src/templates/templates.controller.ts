import { Body, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import type { Page } from '../records/list-query';
import {
    CreateTemplateDto,
    ListTemplatesQueryDto,
    PreviewTemplateDto,
    PutMailSettingsDto,
    UpdateTemplateDto,
} from './dto';
import { editedVersion } from './edited-version';
import { MailSettingsService } from './mail-settings.service';
import type { ComposedEmail } from './render/compose';
import {
    emailTemplatePage,
    emailTemplateView,
    mailSettingsView,
    renderedEmail,
    templateVariables,
    type EmailTemplateView,
    type MailSettingsView,
    type TemplateVariablesView,
} from './responses';
import { TemplatesService } from './templates.service';

/**
 * Email templates (P2-4). Reading is `template:read`; writing is `template:write`, and a template
 * that is or becomes `outreach` also needs `outreach:write` — the service checks that, because it
 * depends on the template, not the route. Static paths come before `:templateId`.
 */
@ApiTags('templates')
@TenantController('templates')
export class TemplatesController {
    constructor(private readonly templates: TemplatesService) {}

    @Requires('template:read')
    @Get()
    @Returns(emailTemplatePage)
    list(@Query() query: ListTemplatesQueryDto): Promise<Page<EmailTemplateView>> {
        return this.templates.list(query);
    }

    @Requires('template:write')
    @Get('deleted')
    @Returns(emailTemplatePage)
    listDeleted(@Query() query: ListTemplatesQueryDto): Promise<Page<EmailTemplateView>> {
        return this.templates.list(query, true);
    }

    /** The variables a template may name: the registry, and the workspace's custom fields. */
    @Requires('template:read')
    @Get('variables')
    @Returns(templateVariables)
    variables(): Promise<TemplateVariablesView> {
        return this.templates.variables();
    }

    @Requires('template:read')
    @Get(':templateId')
    @Returns(emailTemplateView)
    get(@Param('templateId', ParseUUIDPipe) templateId: string): Promise<EmailTemplateView> {
        return this.templates.get(templateId);
    }

    @Requires('template:write')
    @Post()
    @Returns(emailTemplateView)
    create(@Body() body: CreateTemplateDto): Promise<EmailTemplateView> {
        return this.templates.create(body);
    }

    /** Name the version you edited, in the body or as `If-Match`; a template changed since is `409 conflict`. */
    @Requires('template:write')
    @Patch(':templateId')
    @ApiHeader({
        name: 'If-Match',
        required: false,
        description: 'The version you edited, e.g. "3" (or send `version`).',
    })
    @Returns(emailTemplateView)
    update(
        @Param('templateId', ParseUUIDPipe) templateId: string,
        @Body() body: UpdateTemplateDto,
        @Headers('if-match') ifMatch: string | undefined,
    ): Promise<EmailTemplateView> {
        const { version, ...patch } = body;
        return this.templates.update(templateId, patch, editedVersion(version, ifMatch));
    }

    @Requires('template:write')
    @HttpCode(204)
    @Delete(':templateId')
    remove(@Param('templateId', ParseUUIDPipe) templateId: string): Promise<void> {
        return this.templates.remove(templateId);
    }

    @Requires('template:write')
    @Post(':templateId/restore')
    @Returns(emailTemplateView)
    restore(@Param('templateId', ParseUUIDPipe) templateId: string): Promise<EmailTemplateView> {
        return this.templates.restore(templateId);
    }

    @Requires('template:write')
    @Post(':templateId/duplicate')
    @Returns(emailTemplateView)
    duplicate(@Param('templateId', ParseUUIDPipe) templateId: string): Promise<EmailTemplateView> {
        return this.templates.duplicate(templateId);
    }

    /**
     * The template rendered for one recipient (and deal), sent from the caller. Reading the person
     * is reading a record, so `record:read` too; one the caller cannot see is `404`.
     */
    @Requires('template:read', 'record:read')
    @HttpCode(200)
    @Post(':templateId/preview')
    @Returns(renderedEmail)
    preview(
        @Param('templateId', ParseUUIDPipe) templateId: string,
        @Body() body: PreviewTemplateDto,
    ): Promise<ComposedEmail> {
        return this.templates.preview(templateId, body);
    }
}

/** The workspace's mail settings: anyone who reads records reads them; an administrator writes them. */
@ApiTags('templates')
@TenantController('settings/mail')
export class MailSettingsController {
    constructor(private readonly settings: MailSettingsService) {}

    @Requires('record:read')
    @Get()
    @Returns(mailSettingsView)
    get(): Promise<MailSettingsView> {
        return this.settings.get();
    }

    @Requires('workspace:admin')
    @Put()
    @Returns(mailSettingsView)
    put(@Body() body: PutMailSettingsDto): Promise<MailSettingsView> {
        return this.settings.put(body);
    }
}
