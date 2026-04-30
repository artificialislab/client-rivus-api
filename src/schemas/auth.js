/**
 * Zod schemas — auth.
 */
import { z } from 'zod';

export const LoginInputSchema = z.object({
  email:    z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});

export const SeedAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name:  z.string().trim().max(200).optional(),
});
