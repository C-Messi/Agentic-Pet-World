import { z } from 'zod';

const booleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalString = (schema: z.ZodString) =>
  z.preprocess(
    (value) => typeof value === 'string' && value.trim().length === 0
      ? undefined
      : value,
    schema.optional(),
  );

const environmentSchema = z
  .object({
    USE_FAKE_LLM: booleanStringSchema,
    LLM_BASE_URL: optionalString(z.string().trim().url()),
    LLM_API_KEY: optionalString(z.string().trim().min(1)),
    LLM_MODEL: optionalString(z.string().trim().min(1).max(200)),
    LLM_TEMPERATURE: z.coerce.number().finite().min(0).max(2).default(0.4),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(250).max(120_000).default(15_000),
  })
  .passthrough();

const runtimeEnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().trim().min(1).default('./data/cat-house.sqlite'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8_787),
    HOST: z.string().trim().min(1).max(255).default('127.0.0.1'),
    WEB_ORIGIN: z.string().trim().url().default('http://127.0.0.1:5173'),
  })
  .passthrough();

export interface FakeLlmConfig {
  readonly kind: 'fake';
}

export interface OpenAICompatibleLlmConfig {
  readonly kind: 'openai-compatible';
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature: number;
  readonly timeoutMs: number;
}

export interface UnavailableLlmConfig {
  readonly kind: 'unavailable';
  readonly reason: 'missing_configuration';
}

export interface ServerConfig {
  readonly llm: FakeLlmConfig | OpenAICompatibleLlmConfig | UnavailableLlmConfig;
}

export interface RuntimeServerConfig {
  readonly databasePath: string;
  readonly port: number;
  readonly host: string;
  readonly webOrigin: string;
}

export function parseRuntimeServerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeServerConfig {
  const parsed = runtimeEnvironmentSchema.parse(environment);
  return {
    databasePath: parsed.DATABASE_URL,
    port: parsed.PORT,
    host: parsed.HOST,
    webOrigin: parsed.WEB_ORIGIN,
  };
}

export function parseServerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const parsed = environmentSchema.parse(environment);
  if (parsed.USE_FAKE_LLM) {
    return { llm: { kind: 'fake' } };
  }
  if (
    parsed.LLM_BASE_URL === undefined
    || parsed.LLM_API_KEY === undefined
    || parsed.LLM_MODEL === undefined
  ) {
    return {
      llm: {
        kind: 'unavailable',
        reason: 'missing_configuration',
      },
    };
  }

  const llm = {
    kind: 'openai-compatible',
    baseURL: parsed.LLM_BASE_URL,
    model: parsed.LLM_MODEL,
    temperature: parsed.LLM_TEMPERATURE,
    timeoutMs: parsed.LLM_TIMEOUT_MS,
  } as OpenAICompatibleLlmConfig;
  Object.defineProperty(llm, 'apiKey', {
    value: requireParsedValue(parsed.LLM_API_KEY, 'LLM_API_KEY'),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return {
    llm: Object.freeze(llm),
  };
}

function requireParsedValue(value: string | undefined, field: string): string {
  if (value === undefined) {
    throw new Error(`${field} is required`);
  }
  return value;
}
