import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { APP_COMPILE_TIMEOUT_MS, applyPlaceholderEnv } from '../openapi/placeholder-env';
import { ANY_MEMBER_KEY, REQUIRES_KEY, requiredCapabilities } from './decorators';
import { TENANT_PATH } from './guards';

/**
 * Every route under `/api/w/:workspaceId` declares the capability it needs. The guard refuses an
 * undeclared route at runtime; this walks the router at test time so the defect is found before
 * a request ever reaches it. The module is compiled, not initialised: no connection is opened.
 */
describe('tenant routes declare a capability', () => {
    const routes: { route: string; capability: unknown; openReason: unknown }[] = [];

    beforeAll(async () => {
        applyPlaceholderEnv();
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
                    openReason: Reflect.getMetadata(ANY_MEMBER_KEY, handler),
                });
            }
        }
    }, APP_COMPILE_TIMEOUT_MS);

    it('finds the tenant routes this package added', () => {
        expect(routes.length).toBeGreaterThanOrEqual(30);
    });

    it('every one of them names capabilities from the catalogue, or is open to any member for a written reason', () => {
        const open = (r: { openReason: unknown }) => typeof r.openReason === 'string' && r.openReason.trim().length > 0;
        const undeclared = routes.filter((r) => !requiredCapabilities(r.capability) && !open(r)).map((r) => r.route);
        expect(undeclared, 'tenant routes with no @Requires() and no @AnyMember(reason)').toEqual([]);
    });

    it('a route gated by several capabilities counts as gated (the deal bulk route)', () => {
        const bulk = routes.find((r) => r.route === 'OpportunitiesController.bulk');
        expect(requiredCapabilities(bulk?.capability)).toEqual(['deal:bulk', 'deal:edit']);
    });

    it('the routes open to any member are exactly the ones about the caller themselves', () => {
        const open = routes.filter((r) => typeof r.openReason === 'string').map((r) => r.route);
        // What the caller may do, and (#192) the caller's own notifications, open tasks and notification settings.
        expect(open.sort()).toEqual(
            [
                'WorkspaceMeController.standing',
                'NotificationsController.list',
                'NotificationsController.read',
                'MyTasksController.list',
                'NotificationSettingsController.get',
                'NotificationSettingsController.update',
            ].sort(),
        );
    });
});
