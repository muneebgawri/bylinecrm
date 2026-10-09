import { CAPABILITIES, RECORD_SCOPES } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './auth.constants';

const email = z.email().max(254);
const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
const name = z.string().trim().min(1).max(120);
const capability = z.enum(CAPABILITIES);
const recordScope = z.enum(RECORD_SCOPES);

export class SignupDto extends createZodDto(z.object({ email, password, workspaceName: name })) {}
export class LoginDto extends createZodDto(z.object({ email, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) })) {}
export class CreateWorkspaceDto extends createZodDto(z.object({ name })) {}
export class AcceptInviteSignupDto extends createZodDto(z.object({ password })) {}

export class CreateRoleDto extends createZodDto(
    z.object({
        name,
        capabilities: z.array(capability).max(CAPABILITIES.length),
        recordScope: recordScope.optional(),
    }),
) {}
export class UpdateRoleDto extends createZodDto(
    z.object({
        name: name.optional(),
        capabilities: z.array(capability).max(CAPABILITIES.length).optional(),
        recordScope: recordScope.optional(),
    }),
) {}
export class SetMemberRoleDto extends createZodDto(z.object({ roleId: z.uuid() })) {}
export class CreateApiKeyDto extends createZodDto(z.object({ name, roleId: z.uuid() })) {}
export class CreateInviteDto extends createZodDto(z.object({ email, roleId: z.uuid() })) {}
