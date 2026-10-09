import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { SavedView } from '@bylinecrm/shared';
import { Requires } from '../auth/decorators';
import { CreateViewDto, ListViewsQueryDto, UpdateViewDto } from './dto';
import { ViewsService } from './views.service';

/**
 * Saved views. Reading needs `record:read` (a view is how a list is looked at); writing one's own
 * needs `view:save`; sharing, or changing a shared one, needs `view:share` as well — the service
 * checks that second gate because it depends on the row, not only the route.
 */
@ApiTags('views')
@Controller('w/:workspaceId/views')
export class ViewsController {
    constructor(private readonly views: ViewsService) {}

    @Requires('record:read')
    @Get()
    list(@Query() query: ListViewsQueryDto): Promise<SavedView[]> {
        return this.views.list(query.object);
    }

    @Requires('record:read')
    @Get(':viewId')
    get(@Param('viewId', ParseUUIDPipe) viewId: string): Promise<SavedView> {
        return this.views.get(viewId);
    }

    @Requires('view:save')
    @Post()
    create(@Body() body: CreateViewDto): Promise<SavedView> {
        const { object, ...input } = body;
        return this.views.create(object, input);
    }

    @Requires('view:save')
    @Patch(':viewId')
    update(@Param('viewId', ParseUUIDPipe) viewId: string, @Body() body: UpdateViewDto): Promise<SavedView> {
        return this.views.update(viewId, body);
    }

    @Requires('view:save')
    @HttpCode(204)
    @Delete(':viewId')
    remove(@Param('viewId', ParseUUIDPipe) viewId: string): Promise<void> {
        return this.views.remove(viewId);
    }

    @Requires('view:save')
    @Post(':viewId/duplicate')
    duplicate(@Param('viewId', ParseUUIDPipe) viewId: string): Promise<SavedView> {
        return this.views.duplicate(viewId);
    }
}
