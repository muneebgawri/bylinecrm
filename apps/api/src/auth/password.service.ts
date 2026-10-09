import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { ARGON2 } from './auth.constants';

/** The one place a password is hashed or checked. argon2id; the comparison is constant-time. */
@Injectable()
export class PasswordService {
    hash(password: string): Promise<string> {
        return hash(password, ARGON2);
    }

    /** `false` on a mismatch or a malformed hash; never throws for a bad input. */
    async verify(password: string, passwordHash: string): Promise<boolean> {
        try {
            return await verify(passwordHash, password);
        } catch {
            return false;
        }
    }
}
