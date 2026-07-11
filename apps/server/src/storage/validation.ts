import { z } from 'zod';

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const TimestampSchema = z.string().datetime({ offset: true });

export function parseJson<T>(json: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(json));
}
