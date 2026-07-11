import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { MemoryRecord, MessageRecord, WorldSnapshot } from '@cat-house/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextService } from './context-service.js';
import {
  KnowledgeService,
  type KnowledgeDocumentId,
} from '../knowledge/knowledge-service.js';

const productionContentDirectory = join(import.meta.dirname, '../../content');
const timestamp = '2026-07-12T08:30:00.000Z';

const world: WorldSnapshot = {
  cat: {
    position: { x: 4, y: 7 },
    emotion: 'curious',
    currentTargetId: 'window',
  },
  objects: [
    {
      id: 'window',
      position: { x: 8, y: 2 },
      available: true,
      interactions: ['inspect', 'open'],
    },
    {
      id: 'arcade',
      position: { x: 2, y: 3 },
      available: false,
      interactions: ['inspect', 'play'],
    },
  ],
};

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cat-house-knowledge-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeDocument(directory: string, path: string, source: string): void {
  const destination = join(directory, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source);
}

function createContextService(options?: {
  memories?: readonly MemoryRecord[];
  messages?: readonly MessageRecord[];
  recentMessageLimit?: number;
  characterBudget?: number;
  knowledge?: KnowledgeService;
}): ContextService {
  return new ContextService(
    options?.knowledge ?? new KnowledgeService(productionContentDirectory),
    { listForSession: () => options?.memories ?? [] },
    { listForSession: () => options?.messages ?? [] },
    {
      recentMessageLimit: options?.recentMessageLimit ?? 10,
      characterBudget: options?.characterBudget ?? 20_000,
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('KnowledgeService', () => {
  it('loads and validates every authored knowledge document', () => {
    const knowledge = new KnowledgeService(productionContentDirectory);

    expect(knowledge.list().map((document) => document.id)).toEqual([
      'character',
      'world',
      'object:arcade',
      'object:bed',
      'object:bookshelf',
      'object:food-bowl',
      'object:sofa',
      'object:toy-basket',
      'object:window',
      'minigame:arcade',
    ] satisfies KnowledgeDocumentId[]);
    expect(knowledge.get('object:arcade').metadata).toMatchObject({
      kind: 'object',
      objectId: 'arcade',
      availability: 'coming-soon',
    });
  });

  it('rejects unknown and duplicate stable document IDs', () => {
    const unknownDirectory = createTemporaryDirectory();
    writeDocument(
      unknownDirectory,
      'unknown.md',
      '---\nid: surprise\nkind: character\ntitle: Surprise\n---\nNo.',
    );
    expect(() => new KnowledgeService(unknownDirectory)).toThrow(
      /unknown knowledge document id/i,
    );

    const duplicateDirectory = createTemporaryDirectory();
    const source = '---\nid: character\nkind: character\ntitle: Cat\n---\nWarm.';
    writeDocument(duplicateDirectory, 'one.md', source);
    writeDocument(duplicateDirectory, 'two.md', source);
    expect(() => new KnowledgeService(duplicateDirectory)).toThrow(
      /duplicate knowledge document id/i,
    );
  });

  it('validates frontmatter against the stable ID kind', () => {
    const directory = createTemporaryDirectory();
    writeDocument(
      directory,
      'bad.md',
      '---\nid: object:bed\nkind: object\nobjectId: window\ntitle: Bed\n'
        + 'availability: available\n---\nSoft.',
    );

    expect(() => new KnowledgeService(directory)).toThrow(/frontmatter/i);
  });

  it('reloads changed Markdown only when development reload is enabled', () => {
    const directory = createTemporaryDirectory();
    writeDocument(
      directory,
      'character.md',
      '---\nid: character\nkind: character\ntitle: Cat\n---\nFirst voice.',
    );
    const knowledge = new KnowledgeService(directory, {
      allowDevelopmentReload: true,
    });

    writeDocument(
      directory,
      'character.md',
      '---\nid: character\nkind: character\ntitle: Cat\n---\nSecond voice.',
    );
    expect(knowledge.get('character').content).toBe('First voice.');

    knowledge.reload();

    expect(knowledge.get('character').content).toBe('Second voice.');
    expect(() => new KnowledgeService(directory).reload()).toThrow(
      /development reload is disabled/i,
    );
  });
});

describe('ContextService', () => {
  it('includes only the relevant target object document in deterministic section order', () => {
    const context = createContextService().build({
      sessionId: 'session-1',
      worldSnapshot: world,
    });

    expect(context.sections.map((section) => section.kind)).toEqual([
      'safety',
      'character',
      'world',
      'object',
      'memories',
      'messages',
      'world-snapshot',
    ]);
    expect(context.selectedKnowledgeIds).toEqual([
      'character',
      'world',
      'object:window',
    ]);
    expect(context.rendered).toContain('object:window');
    expect(context.rendered).not.toContain('object:arcade');
  });

  it('orders memories by importance descending, then recency, with stable ID ties', () => {
    const memories: MemoryRecord[] = [
      {
        id: 'low',
        sessionId: 'session-1',
        content: 'Low',
        importance: 0.2,
        createdAt: timestamp,
        updatedAt: '2026-07-12T08:34:00.000Z',
      },
      {
        id: 'older-b',
        sessionId: 'session-1',
        content: 'Older B',
        importance: 0.9,
        createdAt: timestamp,
        updatedAt: '2026-07-12T08:31:00.000Z',
      },
      {
        id: 'newer',
        sessionId: 'session-1',
        content: 'Newer',
        importance: 0.9,
        createdAt: timestamp,
        updatedAt: '2026-07-12T08:33:00.000Z',
      },
      {
        id: 'older-a',
        sessionId: 'session-1',
        content: 'Older A',
        importance: 0.9,
        createdAt: timestamp,
        updatedAt: '2026-07-12T08:31:00.000Z',
      },
    ];

    const context = createContextService({ memories }).build({
      sessionId: 'session-1',
      worldSnapshot: world,
    });

    expect(context.selectedMemoryIds).toEqual([
      'newer',
      'older-a',
      'older-b',
      'low',
    ]);
  });

  it('caps recent messages and preserves chronological order', () => {
    const messages: MessageRecord[] = Array.from({ length: 5 }, (_, index) => ({
      id: `message-${index + 1}`,
      sessionId: 'session-1',
      role: index % 2 === 0 ? 'player' as const : 'agent' as const,
      content: `Message ${index + 1}`,
      createdAt: `2026-07-12T08:3${index}:00.000Z`,
    }));

    const context = createContextService({
      messages,
      recentMessageLimit: 3,
    }).build({ sessionId: 'session-1', worldSnapshot: world });

    expect(context.selectedMessageIds).toEqual(['message-3', 'message-4', 'message-5']);
  });

  it('trims oldest messages before lowest-importance memories to meet the budget', () => {
    const messages: MessageRecord[] = ['oldest', 'middle', 'newest'].map(
      (id, index) => ({
        id,
        sessionId: 'session-1',
        role: 'player' as const,
        content: `Conversation ${id} ${'x'.repeat(80)}`,
        createdAt: `2026-07-12T08:3${index}:00.000Z`,
      }),
    );
    const memories: MemoryRecord[] = [
      {
        id: 'important',
        sessionId: 'session-1',
        content: `Important ${'y'.repeat(80)}`,
        importance: 0.9,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 'minor',
        sessionId: 'session-1',
        content: `Minor ${'z'.repeat(80)}`,
        importance: 0.1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    const unbounded = createContextService({ messages, memories }).build({
      sessionId: 'session-1',
      worldSnapshot: world,
    });
    const oldestStart = unbounded.rendered.indexOf('[oldest]');
    const oldestLineLength =
      unbounded.rendered.indexOf('\n', oldestStart) - oldestStart + 1;
    const budget = unbounded.characterCount - oldestLineLength;

    const messagesTrimmed = createContextService({
      messages,
      memories,
      characterBudget: budget,
    }).build({ sessionId: 'session-1', worldSnapshot: world });
    expect(messagesTrimmed.selectedMessageIds).toEqual(['middle', 'newest']);
    expect(messagesTrimmed.selectedMemoryIds).toEqual(['important', 'minor']);

    const importantOnly = createContextService({ memories: [memories[0]!] }).build({
      sessionId: 'session-1',
      worldSnapshot: world,
    });
    const memoriesTrimmed = createContextService({
      messages,
      memories,
      characterBudget: importantOnly.characterCount,
    }).build({ sessionId: 'session-1', worldSnapshot: world });
    expect(memoriesTrimmed.selectedMessageIds).toEqual([]);
    expect(memoriesTrimmed.selectedMemoryIds).toEqual(['important']);
    expect(memoriesTrimmed.characterCount).toBeLessThanOrEqual(
      importantOnly.characterCount,
    );
  });

  it('always retains complete safety rules and the compact world snapshot', () => {
    const baseline = createContextService().build({
      sessionId: 'session-1',
      worldSnapshot: world,
    });
    const requiredLength = baseline.sections
      .filter((section) => section.kind !== 'memories' && section.kind !== 'messages')
      .map((section) => section.rendered)
      .join('\n\n').length;
    const context = createContextService({
      characterBudget: requiredLength,
    }).build({ sessionId: 'session-1', worldSnapshot: world });

    expect(context.sections[0]?.rendered).toBe(baseline.sections[0]?.rendered);
    expect(context.sections.at(-1)?.rendered).toBe(baseline.sections.at(-1)?.rendered);
    expect(context.sections.at(-1)?.rendered).toContain('"currentTargetId":"window"');
  });

  it('produces identical output for identical inputs', () => {
    const service = createContextService();
    const first = service.build({ sessionId: 'session-1', worldSnapshot: world });
    const second = service.build({ sessionId: 'session-1', worldSnapshot: world });

    expect(second).toEqual(first);
  });
});
