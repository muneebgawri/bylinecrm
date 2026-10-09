import { Module } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';

/**
 * The workspace's custom-field definitions, as a module of their own: the records module writes
 * values against them, and the query and views modules (P1-4) resolve `custom.<key>` fields
 * against the same list — one provider, imported by each, no module depending on the other.
 */
@Module({
    providers: [CustomFieldsService],
    exports: [CustomFieldsService],
})
export class CustomFieldsModule {}
