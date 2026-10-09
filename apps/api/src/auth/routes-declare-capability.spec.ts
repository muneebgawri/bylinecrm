import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { isCapability } from '@bylinecrm/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { REQUIRES_KEY } from './decorators';
import { TENANT_PATH } from './guards';

/**
 * Every route under `/api/w/:workspaceId` declares the capability it needs. The guard refuses an
 * undeclared route at runtime; this walks the router at test time so the defect is found before
 * a request ever reaches it. The module is compiled, not initialised: no connection is opened.
 */
describe('tenant routes declare a capability', () => {
    const routes: { route: string; capability: unknown }[] = [];

    beforeAll(async () => {
        Object.assign(process.env, {
            DATABASE_URL: 'postgresql://owner:x@localhost:1/db',
            RLS_DATABASE_URL: 'postgresql://bylinecrm_app:x@localhost:1/db',
            REDIS_URL: 'redis://localhost:1',
            PORT: '1',
            APP_URL: 'http://localhost:1',
            WEB_URL: 'http://localhost:2',
        });
        const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
        const discovery = moduleRef.get(DiscoveryService);
        const scanner = moduleRef.get(MetadataScanner);
        const tenantPrefix = TENANT_PATH.replace(/^\/api\//, '');
        for (const wrapper of discovery.getControllers()) {
            const controller = wrapper.metatype as (new () => object) | null;
            if (!controller) continue;
            const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
            if (!base.startsWith(tenantPrefix)) continue;
            const prototype = controller.prototype as Record<string, unknown>;
            for (const name of scanner.getAllMethodNames(prototype)) {
                const handler = prototype[name] as object;
                if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
                routes.push({
                    route: `${controller.name}.${name}`,
                    capability: Reflect.getMetadata(REQUIRES_KEY, handler),
                });
            }
        }
    });

    it('finds the tenant routes this package added', () => {
        expect(routes.length).toBeGreaterThanOrEqual(12);
    });

    it('every one of them names a capability from the catalogue', () => {
        const undeclared = routes.filter((r) => !isCapability(r.capability)).map((r) => r.route);
        expect(undeclared, 'tenant routes with no @Requires()').toEqual([]);
    });
});
