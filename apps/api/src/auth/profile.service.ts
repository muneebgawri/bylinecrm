import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import type { ProfileView } from '../workspace/responses';

/**
 * The person's own profile: the display name every workspace names them by (P1-UI-10). Read and
 * written through the restricted client under `app.user_id`, whose `users` policies show and update
 * one row — the caller's — so no owner-client write is added to a request path (P0-3's table of
 * owner-client writers stays as it was).
 */
@Injectable()
export class ProfileService {
    constructor(private readonly rls: RlsPrismaService) {}

    get(userId: string): Promise<ProfileView> {
        return this.rls.withUser(userId, async (tx) => {
            const user = await tx.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
            if (!user) throw new UnauthorizedException();
            return profileView(user);
        });
    }

    /** Saving the name — the suggested one kept, or a new one — is what confirms the profile. */
    setDisplayName(userId: string, displayName: string): Promise<ProfileView> {
        return this.rls.withUser(userId, async (tx) => {
            const user = await tx.user.update({
                where: { id: userId },
                data: { displayName, profileCompletedAt: new Date() },
                select: PROFILE_SELECT,
            });
            return profileView(user);
        });
    }
}

const PROFILE_SELECT = { email: true, displayName: true, profileCompletedAt: true } as const;

function profileView(user: {
    email: string;
    displayName: string | null;
    profileCompletedAt: Date | null;
}): ProfileView {
    return { email: user.email, displayName: user.displayName, completed: user.profileCompletedAt !== null };
}
