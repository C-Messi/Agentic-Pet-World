import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { AgentService } from './agent/agent-service.js';
import { ContextService } from './agent/context-service.js';
import { FakeProvider } from './agent/fake-provider.js';
import { OpenAICompatibleProvider } from './agent/openai-compatible-provider.js';
import type { ProviderAdapter } from './agent/provider.js';
import { StorageTurnPersistence } from './agent/turn-persistence.js';
import { buildApp } from './app.js';
import { parseRuntimeServerConfig, parseServerConfig } from './config.js';
import {
  KnowledgeService,
  resolveContentDirectory,
} from './knowledge/knowledge-service.js';
import { StorageApiStore } from './storage/api-store.js';
import { openDatabase } from './storage/database.js';
import {
  MemoryRepository,
  MessageRepository,
} from './storage/repositories/index.js';

const runtimeConfig = parseRuntimeServerConfig(process.env);
const providerConfig = parseServerConfig(process.env);
const databasePath = resolveDatabasePath(runtimeConfig.databasePath);
if (databasePath !== ':memory:') {
  mkdirSync(dirname(databasePath), { recursive: true });
}
const database = openDatabase(databasePath);
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
  provider,
  persistence: new StorageTurnPersistence(database),
  clock: () => new Date().toISOString(),
  idFactory: (prefix) => `${prefix}-${randomUUID()}`,
});
const store = new StorageApiStore(database);
const app = buildApp({
  webOrigin: runtimeConfig.webOrigin,
  store,
  agentService,
  readiness: () => ({
    config: true,
    storage: databaseIsReady(),
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

let closing = false;
async function closeGracefully(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  await app.close();
}
process.once('SIGINT', () => { void closeGracefully(); });
process.once('SIGTERM', () => { void closeGracefully(); });

await app.listen({ host: runtimeConfig.host, port: runtimeConfig.port });

function createProvider(config: ReturnType<typeof parseServerConfig>['llm']): ProviderAdapter {
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

function databaseIsReady(): boolean {
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
