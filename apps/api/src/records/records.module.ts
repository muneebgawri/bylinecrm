import { Module } from '@nestjs/common';
import { NotesController, OpportunitiesController, TasksController } from './activities.controllers';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { CompaniesService } from './companies.service';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { NotesService } from './notes.service';
import { OpportunitiesService } from './opportunities.service';
import { PeopleService } from './people.service';
import { CompaniesController, CustomFieldsController, PeopleController } from './records.controllers';
import { TasksService } from './tasks.service';

/** People, companies, deals, the custom fields on them, and the notes, tasks and files attached to them. */
@Module({
    controllers: [
        PeopleController,
        CompaniesController,
        CustomFieldsController,
        OpportunitiesController,
        NotesController,
        TasksController,
        AttachmentsController,
    ],
    providers: [
        PeopleService,
        CompaniesService,
        CustomFieldsService,
        OpportunitiesService,
        NotesService,
        TasksService,
        AttachmentsService,
    ],
    exports: [PeopleService, CompaniesService, CustomFieldsService, OpportunitiesService, NotesService, TasksService],
})
export class RecordsModule {}
