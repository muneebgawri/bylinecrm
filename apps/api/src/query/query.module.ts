import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RECORD_OBJECTS, type SearchResults } from '@bylinecrm/shared';
import { Requires } from '../auth/decorators';
import { CustomFieldsModule } from '../records/custom-fields/custom-fields.module';
import { SearchQueryDto } from './dto';
import { ExportService } from './export.service';
import { QueryService } from './query.service';
import { SearchService } from './search.service';

/**
 * Global search across people, companies and deals, for the command palette. `record:read`
 * is the gate; a caller who may read records but not deals (`deal:read`) still gets no deals —
 * the service narrows the objects to what the caller's capabilities reach.
 */
@ApiTags('search')
@Controller('w/:workspaceId/search')
export class SearchController {
    constructor(private readonly search: SearchService) {}

    @Requires('record:read')
    @Get()
    find(@Query() query: SearchQueryDto): Promise<SearchResults> {
        return this.search.search(query.q, query.limit, query.objects ?? RECORD_OBJECTS);
    }
}

/**
 * Filters, sorts, grouping, export and search over the record objects (P1-4). The per-object
 * routes (`export.csv`, `query`, `group-by`) live on the record controllers, declared before the
 * `:id` routes so they are matched first; this module provides what they call.
 */
@Module({
    imports: [CustomFieldsModule],
    controllers: [SearchController],
    providers: [ExportService, QueryService, SearchService],
    exports: [ExportService, QueryService],
})
export class QueryModule {}
