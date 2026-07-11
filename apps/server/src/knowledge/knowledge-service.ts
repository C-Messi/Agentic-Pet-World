import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WorldObjectIdSchema, type WorldObjectId } from '@cat-house/shared';
import matter from 'gray-matter';
import { z } from 'zod';

export const KNOWLEDGE_DOCUMENT_IDS = [
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
] as const;

export type KnowledgeDocumentId = (typeof KNOWLEDGE_DOCUMENT_IDS)[number];
export type ObjectKnowledgeDocumentId = `object:${WorldObjectId}`;

const KnowledgeDocumentIdSchema = z.enum(KNOWLEDGE_DOCUMENT_IDS);
const BaseMetadataSchema = z.object({
  id: KnowledgeDocumentIdSchema,
  title: z.string().trim().min(1).max(120),
});

const CharacterMetadataSchema = BaseMetadataSchema.extend({
  id: z.literal('character'),
  kind: z.literal('character'),
}).strict();

const WorldMetadataSchema = BaseMetadataSchema.extend({
  id: z.literal('world'),
  kind: z.literal('world'),
}).strict();

const ObjectMetadataSchema = BaseMetadataSchema.extend({
  id: z.custom<ObjectKnowledgeDocumentId>((value) =>
    typeof value === 'string' && value.startsWith('object:'),
  ),
  kind: z.literal('object'),
  objectId: WorldObjectIdSchema,
  availability: z.enum(['available', 'coming-soon']),
})
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.id !== `object:${metadata.objectId}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Object document ID ${metadata.id} does not match objectId ${metadata.objectId}`,
        path: ['id'],
      });
    }
  });

const MinigameMetadataSchema = BaseMetadataSchema.extend({
  id: z.literal('minigame:arcade'),
  kind: z.literal('minigame'),
  objectId: z.literal('arcade'),
  availability: z.literal('coming-soon'),
}).strict();

const KnowledgeMetadataSchema = z.union([
  CharacterMetadataSchema,
  WorldMetadataSchema,
  ObjectMetadataSchema,
  MinigameMetadataSchema,
]);

export type KnowledgeMetadata = z.infer<typeof KnowledgeMetadataSchema>;

export interface KnowledgeDocument {
  readonly id: KnowledgeDocumentId;
  readonly metadata: KnowledgeMetadata;
  readonly content: string;
  readonly sourcePath: string;
}

export interface KnowledgeServiceOptions {
  readonly allowDevelopmentReload?: boolean;
}

export class KnowledgeService {
  private documents = new Map<KnowledgeDocumentId, KnowledgeDocument>();

  public constructor(
    private readonly contentDirectory: string,
    private readonly options: KnowledgeServiceOptions = {},
  ) {
    this.documents = this.loadDocuments();
  }

  public get(id: KnowledgeDocumentId): KnowledgeDocument {
    const document = this.documents.get(id);
    if (document === undefined) {
      throw new Error(`Knowledge document not loaded: ${id}`);
    }
    return document;
  }

  public getObject(objectId: WorldObjectId): KnowledgeDocument {
    return this.get(`object:${objectId}`);
  }

  public list(): readonly KnowledgeDocument[] {
    return KNOWLEDGE_DOCUMENT_IDS.flatMap((id) => {
      const document = this.documents.get(id);
      return document === undefined ? [] : [document];
    });
  }

  public reload(): void {
    if (this.options.allowDevelopmentReload !== true) {
      throw new Error('Knowledge development reload is disabled');
    }
    this.documents = this.loadDocuments();
  }

  private loadDocuments(): Map<KnowledgeDocumentId, KnowledgeDocument> {
    const documents = new Map<KnowledgeDocumentId, KnowledgeDocument>();

    for (const sourcePath of listMarkdownFiles(this.contentDirectory)) {
      const parsed = matter(readFileSync(sourcePath, 'utf8'));
      const rawId = parsed.data.id;
      const idResult = KnowledgeDocumentIdSchema.safeParse(rawId);
      if (!idResult.success) {
        throw new Error(`Unknown knowledge document ID in ${sourcePath}: ${String(rawId)}`);
      }
      if (documents.has(idResult.data)) {
        throw new Error(`Duplicate knowledge document ID: ${idResult.data}`);
      }

      const metadataResult = KnowledgeMetadataSchema.safeParse(parsed.data);
      if (!metadataResult.success) {
        throw new Error(
          `Invalid knowledge frontmatter in ${sourcePath}: ${metadataResult.error.message}`,
        );
      }
      const content = parsed.content.trim();
      if (content.length === 0) {
        throw new Error(`Knowledge document content is empty: ${sourcePath}`);
      }

      documents.set(
        idResult.data,
        Object.freeze({
          id: idResult.data,
          metadata: Object.freeze(metadataResult.data),
          content,
          sourcePath,
        }),
      );
    }

    return documents;
  }
}

function listMarkdownFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return listMarkdownFiles(path);
      }
      return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}
