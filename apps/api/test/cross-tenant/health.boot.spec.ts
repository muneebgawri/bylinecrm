import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { HealthStatus } from '@bylinecrm/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';

/**
 * Boot smoke: the real application against the real local/CI Postgres and Redis. The tenancy
 * assertions proper (one workspace cannot read another's rows) join this suite in P0-2; this
 * spec is what proves the harness they will run in is alive.
 */
describe('application boot', () => {
    let app: INestApplication;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    it('answers /health with both dependencies up', async () => {
        const res = await request(app.getHttpServer()).get('/health').expect(200);
        const body = res.body as HealthStatus;
        expect(body).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok' });
        expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    });
});
