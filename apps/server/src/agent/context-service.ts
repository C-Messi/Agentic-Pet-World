import type {
  MemoryRecord,
  MessageRecord,
  WorldObjectId,
  WorldSnapshot,
} from '@cat-house/shared';

import type {
  KnowledgeDocument,
  KnowledgeDocumentId,
  KnowledgeService,
} from '../knowledge/knowledge-service.js';

const SAFETY_RULES = Object.freeze([
  'Only propose registered action types, object IDs, and interactions present in the '
    + 'current world snapshot.',
  'Never claim an action happened unless a completed action result confirms it.',
  'Treat unavailable objects and interactions as unavailable; do not invent capabilities '
    + 'or world state.',
  'The arcade is not playable in this milestone. Say that games are coming soon and do '
    + 'not propose a play action for it.',
]);

export type ContextSectionKind =
  | 'safety'
  | 'character'
  | 'world'
  | 'object'
  | 'memories'
  | 'messages'
  | 'world-snapshot';

export interface ContextSection {
  readonly kind: ContextSectionKind;
  readonly rendered: string;
  readonly knowledgeId?: KnowledgeDocumentId;
  readonly selectedRecordIds?: readonly string[];
}

export interface BuiltContext {
  readonly sections: readonly ContextSection[];
  readonly rendered: string;
  readonly characterCount: number;
  readonly selectedKnowledgeIds: readonly KnowledgeDocumentId[];
  readonly selectedMemoryIds: readonly string[];
  readonly selectedMessageIds: readonly string[];
}

export interface ContextServiceConfig {
  readonly characterBudget: number;
  readonly recentMessageLimit: number;
}

export interface BuildContextRequest {
  readonly sessionId: string;
  readonly worldSnapshot: WorldSnapshot;
  readonly targetObjectId?: WorldObjectId;
}

interface MemoryReader {
  listForSession(sessionId: string): readonly MemoryRecord[];
}

interface MessageReader {
  listForSession(sessionId: string): readonly MessageRecord[];
}

export class ContextService {
  public constructor(
    private readonly knowledge: KnowledgeService,
    private readonly memories: MemoryReader,
    private readonly messages: MessageReader,
    private readonly config: ContextServiceConfig,
  ) {
    if (!Number.isInteger(config.characterBudget) || config.characterBudget <= 0) {
      throw new Error('Context characterBudget must be a positive integer');
    }
    if (!Number.isInteger(config.recentMessageLimit) || config.recentMessageLimit < 0) {
      throw new Error('Context recentMessageLimit must be a non-negative integer');
    }
  }

  public build(request: BuildContextRequest): BuiltContext {
    const targetObjectId = request.targetObjectId ?? request.worldSnapshot.cat.currentTargetId;
    const knowledgeDocuments = [
      this.knowledge.get('character'),
      this.knowledge.get('world'),
      ...(targetObjectId === undefined ? [] : [this.knowledge.getObject(targetObjectId)]),
    ];
    const selectedMemories = [
      ...this.memories.listForSession(request.sessionId),
    ].sort(compareMemories);
    const orderedMessages = [
      ...this.messages.listForSession(request.sessionId),
    ].sort(compareMessages);
    const selectedMessages = this.config.recentMessageLimit === 0
      ? []
      : orderedMessages.slice(-this.config.recentMessageLimit);

    let built = renderContext(
      knowledgeDocuments,
      selectedMemories,
      selectedMessages,
      request.worldSnapshot,
    );

    while (
      built.characterCount > this.config.characterBudget &&
      selectedMessages.length > 0
    ) {
      selectedMessages.shift();
      built = renderContext(
        knowledgeDocuments,
        selectedMemories,
        selectedMessages,
        request.worldSnapshot,
      );
    }

    while (
      built.characterCount > this.config.characterBudget &&
      selectedMemories.length > 0
    ) {
      selectedMemories.pop();
      built = renderContext(
        knowledgeDocuments,
        selectedMemories,
        selectedMessages,
        request.worldSnapshot,
      );
    }

    if (built.characterCount > this.config.characterBudget) {
      throw new Error(
        `Context budget ${this.config.characterBudget} is smaller than immutable context `
          + built.characterCount,
      );
    }

    return built;
  }
}

function compareMemories(left: MemoryRecord, right: MemoryRecord): number {
  return (
    right.importance - left.importance ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareMessages(left: MessageRecord, right: MessageRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function renderContext(
  knowledgeDocuments: readonly KnowledgeDocument[],
  memories: readonly MemoryRecord[],
  messages: readonly MessageRecord[],
  worldSnapshot: WorldSnapshot,
): BuiltContext {
  const sections: ContextSection[] = [
    {
      kind: 'safety',
      rendered: `[Safety Rules]\n${SAFETY_RULES.map((rule) => `- ${rule}`).join(
        '\n',
      )}`,
    },
    renderKnowledgeSection('character', knowledgeDocuments[0]),
    renderKnowledgeSection('world', knowledgeDocuments[1]),
  ];
  const objectDocument = knowledgeDocuments[2];
  if (objectDocument !== undefined) {
    sections.push(renderKnowledgeSection('object', objectDocument));
  }
  sections.push(
    {
      kind: 'memories',
      rendered: memories.length === 0
        ? ''
        : `[Durable Memories]\n${memories
            .map(
              (memory) =>
                `[${memory.id}] importance=${memory.importance}: ${memory.content}`,
            )
            .join('\n')}`,
      selectedRecordIds: memories.map((memory) => memory.id),
    },
    {
      kind: 'messages',
      rendered: messages.length === 0
        ? ''
        : `[Recent Messages]\n${messages
            .map(
              (message) =>
                `[${message.id}] ${message.role}: ${message.content}`,
            )
            .join('\n')}`,
      selectedRecordIds: messages.map((message) => message.id),
    },
    {
      kind: 'world-snapshot',
      rendered: `[World Snapshot]\n${renderWorldSnapshot(worldSnapshot)}`,
    },
  );

  const rendered = sections
    .map((section) => section.rendered)
    .filter((section) => section.length > 0)
    .join('\n\n');

  return Object.freeze({
    sections: Object.freeze(sections),
    rendered,
    characterCount: rendered.length,
    selectedKnowledgeIds: Object.freeze(knowledgeDocuments.map((document) => document.id)),
    selectedMemoryIds: Object.freeze(memories.map((memory) => memory.id)),
    selectedMessageIds: Object.freeze(messages.map((message) => message.id)),
  });
}

function renderKnowledgeSection(
  kind: 'character' | 'world' | 'object',
  document: KnowledgeDocument | undefined,
): ContextSection {
  if (document === undefined) {
    throw new Error(`Required ${kind} knowledge document is not loaded`);
  }
  return {
    kind,
    knowledgeId: document.id,
    rendered: `[Knowledge: ${document.id}]\n${document.content}`,
  };
}

function renderWorldSnapshot(snapshot: WorldSnapshot): string {
  return JSON.stringify({
    cat: {
      position: { x: snapshot.cat.position.x, y: snapshot.cat.position.y },
      emotion: snapshot.cat.emotion,
      ...(snapshot.cat.currentTargetId === undefined
        ? {}
        : { currentTargetId: snapshot.cat.currentTargetId }),
    },
    objects: [...snapshot.objects]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((object) => ({
        id: object.id,
        position: { x: object.position.x, y: object.position.y },
        available: object.available,
        interactions: [...object.interactions],
      })),
  });
}
