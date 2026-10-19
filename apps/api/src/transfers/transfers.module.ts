import { Module } from '@nestjs/common';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

/** Ownership transfers (OWN-1): the one way a record changes hands. */
@Module({
    controllers: [TransfersController],
    providers: [TransfersService],
    exports: [TransfersService],
})
export class TransfersModule {}
