import { Module } from '@nestjs/common';
import { BylineApiHttp } from './byline-api.http';
import { BYLINE_API } from './byline-api.port';
import { BylineLinks } from './byline-links.service';

/** BylineAI's API, by a workspace's key (BYL-2): the client and the link, for the enrichment and verification ports. */
@Module({
    providers: [{ provide: BYLINE_API, useClass: BylineApiHttp }, BylineLinks],
    exports: [BYLINE_API, BylineLinks],
})
export class BylineApiModule {}
