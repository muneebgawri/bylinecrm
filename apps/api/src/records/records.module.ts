import { Module } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { PeopleService } from './people.service';
import { CompaniesController, CustomFieldsController, PeopleController } from './records.controllers';

/** People, companies and the custom fields a workspace adds to them (P1-1a). */
@Module({
    controllers: [PeopleController, CompaniesController, CustomFieldsController],
    providers: [PeopleService, CompaniesService, CustomFieldsService],
    exports: [PeopleService, CompaniesService, CustomFieldsService],
})
export class RecordsModule {}
