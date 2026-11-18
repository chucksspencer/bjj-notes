// Request shapes more than one group of routes uses.
import { z } from 'zod';
import { ROLES, TECHNIQUE_TYPES } from '../../services/vocab.js';

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const id = z.coerce.number().int().positive();
export const newTechnique = z.object({ name: z.string().trim().min(1).max(120), type: z.enum(TECHNIQUE_TYPES), role: z.enum(ROLES).optional() });
export const strList = z.array(z.string().trim().max(500)).max(100);
/** A selection to act on at once. */
export const idList = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });

export const optLine = (max: number) => z.string().trim().max(max).nullable().optional();
