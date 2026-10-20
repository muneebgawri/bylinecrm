import { Module } from '@nestjs/common';
import { MailAssetsController, PublicMailAssetController } from './mail-assets.controllers';
import { MailAssetsService } from './mail-assets.service';

/** Images uploaded for mail, served publicly by an unguessable address. */
@Module({
    controllers: [MailAssetsController, PublicMailAssetController],
    providers: [MailAssetsService],
})
export class MailAssetsModule {}
