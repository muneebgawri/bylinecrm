import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../records/custom-fields/custom-fields.module';
import { ViewsController } from './views.controller';
import { ViewsService } from './views.service';

/** Saved views over the record objects (P1-4). Reads the custom-field definitions to validate what a view names. */
@Module({
    imports: [CustomFieldsModule],
    controllers: [ViewsController],
    providers: [ViewsService],
    exports: [ViewsService],
})
export class ViewsModule {}
