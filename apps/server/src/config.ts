import { z } from 'zod';

const booleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const environmentSchema = z
  .object({
    USE_FAKE_LLM: booleanStringSchema,
    LLM_BASE_URL: z.string().trim().url().optional(),
    LLM_API_KEY: z.string().trim().min(1).optional(),
    LLM_MODEL: z.string().trim().min(1).max(200).optional(),
    LLM_TEMPERATURE: z.coerce.number().finite().min(0).max(2).default(0.4),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(250).max(120_000).default(15_000),
  })
  .passthrough()
  .superRefine((environment, context) => {
    if (environment.USE_FAKE_LLM) {
      return;
    }
    for (const field of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const) {
      if (environment[field] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is required unless USE_FAKE_LLM=true`,
          path: [field],
        });
      }
    }
  });

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

export interface ServerConfig {
  readonly llm: FakeLlmConfig | OpenAICompatibleLlmConfig;
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

  const llm = {
    kind: 'openai-compatible',
    baseURL: requireParsedValue(parsed.LLM_BASE_URL, 'LLM_BASE_URL'),
    model: requireParsedValue(parsed.LLM_MODEL, 'LLM_MODEL'),
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
