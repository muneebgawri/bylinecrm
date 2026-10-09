import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

/** AES-256-GCM: a 12-byte nonce, a 16-byte tag. */
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The format version in front of every ciphertext, so a later scheme can be told apart. */
const FORMAT = 'v1';

/**
 * Secrets the application must be able to *use*, not merely verify — a webhook signing secret
 * (P1-5), a customer's OAuth client secret (P2-1) — are stored encrypted with the one key in
 * `SECRETS_KEY`. A hash would do for a password or an API key, which the application only
 * compares; it cannot do for a secret the application has to present. One box, one key; what it
 * returns is `v1.<nonce>.<ciphertext>.<tag>`, each part base64url.
 */
@Injectable()
export class SecretBox {
    private readonly key: Buffer;

    constructor(@Inject(ENV) env: Env) {
        this.key = env.SECRETS_KEY;
    }

    seal(plaintext: string): string {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv(ALGORITHM, this.key, nonce);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return [FORMAT, b64(nonce), b64(ciphertext), b64(tag)].join('.');
    }

    open(sealed: string): string {
        const [format, nonce, ciphertext, tag] = sealed.split('.');
        if (format !== FORMAT || !nonce || !ciphertext || !tag)
            throw new Error('sealed value is not in a known format');
        const nonceBytes = Buffer.from(nonce, 'base64url');
        const tagBytes = Buffer.from(tag, 'base64url');
        if (nonceBytes.length !== NONCE_BYTES || tagBytes.length !== TAG_BYTES) {
            throw new Error('sealed value is not in a known format');
        }
        const decipher = createDecipheriv(ALGORITHM, this.key, nonceBytes);
        decipher.setAuthTag(tagBytes);
        return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
            'utf8',
        );
    }
}

function b64(bytes: Buffer): string {
    return bytes.toString('base64url');
}
