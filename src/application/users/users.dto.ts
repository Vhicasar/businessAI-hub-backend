import { z } from 'zod';

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  roleId: z.string().min(1),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(10),
  // Required only when the invited email has no existing account:
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  password: z
    .string()
    .min(10)
    .max(128)
    .regex(/[a-zA-Z]/)
    .regex(/[0-9]/)
    .optional(),
});

export const updateMemberSchema = z.object({
  roleId: z.string().min(1).optional(),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  preferences: z.record(z.unknown()).optional(),
});

export type InviteUserDto = z.infer<typeof inviteUserSchema>;
export type AcceptInviteDto = z.infer<typeof acceptInviteSchema>;
export type UpdateMemberDto = z.infer<typeof updateMemberSchema>;
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
