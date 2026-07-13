import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { AgentService } from './agent/agent-service.js';
import { ContextService } from './agent/context-service.js';
import { FakeProvider } from './agent/fake-provider.js';
import { OpenAICompatibleProvider } from './agent/openai-compatible-provider.js';
import type { ProviderAdapter } from './agent/provider.js';
import { StorageTurnPersistence } from './agent/turn-persistence.js';
import { buildApp } from './app.js';
import {
  parseRuntimeServerConfig,
  parseServerConfig,
  type RuntimeServerConfig,
} from './config.js';
import {
  KnowledgeService,
  resolveContentDirectory,
} from './knowledge/knowledge-service.js';
import { StorageApiStore } from './storage/api-store.js';
import { openDatabase } from './storage/database.js';
import { TownService } from './town/town-service.js';
import {
  MemoryRepository,
  MessageRepository,
} from './storage/repositories/index.js';

export interface ProductionApp {
  readonly app: FastifyInstance;
  readonly runtimeConfig: RuntimeServerConfig;
}

export function createProductionApp(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProductionApp {
  const runtimeConfig = parseRuntimeServerConfig(environment);
  const providerConfig = parseServerConfig(environment);
  const databasePath = resolveDatabasePath(runtimeConfig.databasePath);
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const database = openDatabase(databasePath);
  try {
    const knowledge = new KnowledgeService(resolveContentDirectory());
    const memories = new MemoryRepository(database);
    const messages = new MessageRepository(database);
    const contextService = new ContextService(knowledge, memories, messages, {
      characterBudget: 20_000,
      recentMessageLimit: 12,
    });
    const provider = createProvider(providerConfig.llm);
    const agentService = new AgentService({
      contextService,
      ...(provider === undefined ? {} : { provider }),
      persistence: new StorageTurnPersistence(database),
      clock: () => new Date().toISOString(),
      idFactory: (prefix) => `${prefix}-${randomUUID()}`,
    });
    const app = buildApp({
      webOrigin: runtimeConfig.webOrigin,
      store: new StorageApiStore(database),
      agentService,
      townService: new TownService(
        database,
        {
          now: () => new Date().toISOString(),
          random: Math.random,
          nextId: (prefix) => `${prefix}-${randomUUID()}`,
        },
        {
          ...(provider === undefined ? {} : { provider }),
          ...(providerConfig.llm.kind === 'openai-compatible'
            ? { llmTimeoutMs: providerConfig.llm.timeoutMs }
            : {}),
        },
      ),
      readiness: () => ({
        config: providerConfig.llm.kind !== 'unavailable',
        storage: databaseIsReady(database),
        knowledge: knowledge.list().length > 0,
      }),
      clock: () => new Date().toISOString(),
      idFactory: (prefix) => `${prefix}-${randomUUID()}`,
    });
    app.addHook('onClose', async () => {
      if (database.open) {
        database.close();
      }
    });
    return { app, runtimeConfig };
  } catch (error) {
    database.close();
    throw error;
  }
}

function createProvider(
  config: ReturnType<typeof parseServerConfig>['llm'],
): ProviderAdapter | undefined {
  if (config.kind === 'unavailable') {
    return undefined;
  }
  if (config.kind === 'fake') {
    return new FakeProvider();
  }
  return new OpenAICompatibleProvider({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
  });
}

function resolveDatabasePath(databasePath: string): string {
  return databasePath === ':memory:' ? databasePath : resolve(databasePath);
}

function databaseIsReady(database: ReturnType<typeof openDatabase>): boolean {
  if (!database.open) {
    return false;
  }
  try {
    database.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
