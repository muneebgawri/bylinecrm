import { Inject, Injectable } from '@nestjs/common';
import { BIGIN_IMPORT_OBJECTS, type BiginImportObject } from '@bylinecrm/shared';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { BIGIN_MAPPED_FIELDS } from './bigin-import.constants';
import { readBiginConnection } from './bigin-import.settings';
import { BiginApiError } from './bigin.http';
import { BIGIN_PORT, type BiginApi, type BiginField } from './bigin.port';
import { countBiginLinks } from './links';

/** One module of the Bigin account, as the inventory reports it. */
export interface BiginInventoryModule {
    apiName: string;
    label: string;
    /** Records in Bigin; null when Bigin would not count them (the error says why). */
    remote: number | null;
    /** Whether the importer reads this module (BIGIN-1: `BIGIN_IMPORT_OBJECTS`). */
    imported: boolean;
    /** Bigin records linked to a CRM record (imported modules only). */
    linked: number | null;
    error: string | null;
}

export interface BiginInventory {
    checkedAt: string;
    modules: BiginInventoryModule[];
    /** Per imported module: the custom fields Bigin has, and whether the importer carries each over. */
    customFields: { module: string; label: string; apiName: string; type: string; carried: boolean }[];
    /** Deals' pipelines (the `Pipeline` picklist): the importer places every deal in the default pipeline. */
    pipelines: string[];
    /** Deals' stages (the `Stage` picklist), for the stage mapping. */
    stages: string[];
}

/**
 * What the Bigin account holds against what BylineCRM has of it (BIGIN-1, before the cutover): every module the API
 * serves with its record count — imported or not, so what would be left behind is measured, not guessed — the
 * custom fields of the imported modules, and the deal pipelines and stages. Only reads: Zoho's `settings/modules`,
 * `settings/fields` and `<Module>/actions/count`, a few dozen calls of the daily API budget.
 */
@Injectable()
export class BiginInventoryService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly secrets: SecretBox,
        @Inject(BIGIN_PORT) private readonly bigin: BiginApi,
    ) {}

    async take(workspaceId: string): Promise<BiginInventory> {
        const { connection, linked } = await this.rls.withWorkspace(workspaceId, async (tx) => {
            const stored = await readBiginConnection(tx, this.secrets);
            if (!stored) throw new Error('Bigin is not connected in this workspace');
            const counts = await Promise.all(BIGIN_IMPORT_OBJECTS.map((object) => countBiginLinks(tx, object)));
            return {
                connection: stored.connection,
                linked: new Map<string, number>(BIGIN_IMPORT_OBJECTS.map((o, i) => [o, counts[i]!] as const)),
            };
        });
        // Zoho is read outside any transaction (the adapter refuses one held open across a network call).
        const imported = new Set<string>(BIGIN_IMPORT_OBJECTS);
        const modules: BiginInventoryModule[] = [];
        for (const m of await this.bigin.modules(connection)) {
            if (!m.apiSupported) continue;
            let remote: number | null = null;
            let error: string | null = null;
            try {
                remote = await this.bigin.count(connection, m.apiName);
                if (remote === null) error = 'Bigin does not count this module';
            } catch (e) {
                if (!(e instanceof BiginApiError) || e.status === 401 || e.status === 403) throw e;
                error = e.message;
            }
            modules.push({
                apiName: m.apiName,
                label: m.label,
                remote,
                imported: imported.has(m.apiName),
                linked: linked.get(m.apiName) ?? null,
                error,
            });
        }
        const customFields: BiginInventory['customFields'] = [];
        let deals: BiginField[] = [];
        for (const object of BIGIN_IMPORT_OBJECTS) {
            const fields = await this.fieldsOrNone(connection, object);
            if (object === 'Deals') deals = fields;
            const carried = new Set(BIGIN_MAPPED_FIELDS[object as BiginImportObject] ?? []);
            for (const f of fields.filter((x) => x.custom)) {
                customFields.push({
                    module: object,
                    label: f.label,
                    apiName: f.apiName,
                    type: f.type,
                    carried: carried.has(f.apiName),
                });
            }
        }
        const picklist = (name: string) => deals.find((f) => f.apiName === name)?.values ?? [];
        return {
            checkedAt: new Date().toISOString(),
            modules,
            customFields,
            pipelines: picklist('Pipeline'),
            stages: picklist('Stage'),
        };
    }

    /** A module's fields, or none when Zoho will not describe them (the grant lacks the settings scope). */
    private async fieldsOrNone(connection: Parameters<BiginApi['fieldDefinitions']>[0], module: string) {
        try {
            return await this.bigin.fieldDefinitions(connection, module);
        } catch (e) {
            if (e instanceof BiginApiError && e.permanent && e.status !== 401 && e.status !== 403) return [];
            throw e;
        }
    }
}
