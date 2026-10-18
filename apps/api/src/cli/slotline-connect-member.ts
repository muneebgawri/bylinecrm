import { SLOTLINE_USERNAME_PATTERN } from '@bylinecrm/shared';
import { PrismaClient } from '@prisma/client';
import { SlotlineApiHttp } from '../calendar/slotline/slotline-api.http';
import { parseEnv } from '../config/env';
import { SecretBox } from '../infra/secret-box';
import { storeSlotlineKey } from '../signatures/slotline-account.service';

/**
 * `node dist/cli/slotline-connect-member.js <workspace-slug> <member-email> < key` — run on the server, inside
 * the api container, by the operator (#196): connects a member's Slotline account with an API key made for
 * them, as the member would in Settings → Signatures. The key arrives on stdin only, is checked with Slotline
 * first (its owner's username), and is kept by the same write a member's own request uses — sealed, its last
 * four shown. Nothing prints the key. Uses the owner connection (`DATABASE_URL`).
 */
async function main(): Promise<void> {
    const [slug, email] = process.argv.slice(2);
    if (!slug || !email) {
        throw new Error('usage: node dist/cli/slotline-connect-member.js <workspace-slug> <member-email> < key');
    }
    const apiKey = (await readStdin()).trim();
    if (!/^\S{8,200}$/.test(apiKey)) throw new Error('expected the API key on stdin');
    const env = parseEnv(process.env);
    const owner = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    try {
        const member = await owner.workspaceMember.findFirst({
            where: { workspace: { slug }, user: { email: email.toLowerCase() }, leftAt: null },
            select: { id: true, workspace: { select: { slotlineSettings: { select: { baseUrl: true } } } } },
        });
        if (!member) throw new Error(`${email} is not a member of ${slug}`);
        const base = member.workspace.slotlineSettings?.baseUrl;
        if (!base) throw new Error(`${slug} has no Slotline set up`);
        const { username } = await new SlotlineApiHttp().me(base, apiKey);
        if (!SLOTLINE_USERNAME_PATTERN.test(username))
            throw new Error('Slotline gave a username a booking link cannot carry');
        await owner.$transaction((tx) => storeSlotlineKey(tx, new SecretBox(env), member.id, apiKey, username));
        console.log(`${email}: Slotline account ${username} connected, key ending ${apiKey.slice(-4)}`);
    } finally {
        await owner.$disconnect();
    }
}

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk: string) => (data += chunk));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
