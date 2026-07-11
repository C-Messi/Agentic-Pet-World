import { z } from 'zod';

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const TimestampSchema = z.string().datetime({ offset: true });

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export function normalizeTimestamp(value: string): string {
  return new Date(TimestampSchema.parse(value)).toISOString();
}

export function parseJson<T>(json: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(json));
}

export function parseJsonCompatible<T>(json: string, schema: z.ZodType<T>): T {
  const value = schema.parse(JSON.parse(json));
  JsonValueSchema.parse(value);
  return value;
}

export function serializeJsonCompatible<T>(
  value: T,
  schema: z.ZodType<T>,
): string {
  const parsed = schema.parse(value);
  const json = JSON.stringify(JsonValueSchema.parse(parsed));
  if (json === undefined) {
    throw new Error('Value cannot be represented as JSON');
  }
  const roundTripped = schema.parse(JSON.parse(json));
  const roundTrippedJson = JSON.stringify(JsonValueSchema.parse(roundTripped));

  if (roundTrippedJson !== json) {
    throw new Error('JSON payload does not round-trip through its schema');
  }

  return json;
}
