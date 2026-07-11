import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export const MAX_KNOWLEDGE_FRONTMATTER_CHARACTERS = 1_000;
export const MAX_KNOWLEDGE_FILE_CHARACTERS = 3_100;
export const MAX_KNOWLEDGE_CONTENT_CHARACTERS = Object.freeze({
  character: 1_600,
  world: 2_000,
  object: 800,
  minigame: 800,
});
export const MAX_TOTAL_KNOWLEDGE_CHARACTERS = 10_000;

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
      const source = readFileSync(sourcePath, 'utf8');
      if (countCharacters(source) > MAX_KNOWLEDGE_FILE_CHARACTERS) {
        throw new Error(
          `Knowledge file exceeds ${MAX_KNOWLEDGE_FILE_CHARACTERS} characters: ${sourcePath}`,
        );
      }
      const frontmatterCharacters = countFrontmatterCharacters(source);
      if (frontmatterCharacters > MAX_KNOWLEDGE_FRONTMATTER_CHARACTERS) {
        throw new Error(
          'Knowledge frontmatter exceeds '
            + `${MAX_KNOWLEDGE_FRONTMATTER_CHARACTERS} characters: ${sourcePath}`,
        );
      }
      const parsed = matter(source);
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
      const contentLimit = MAX_KNOWLEDGE_CONTENT_CHARACTERS[metadataResult.data.kind];
      if (countCharacters(content) > contentLimit) {
        throw new Error(
          `Knowledge content exceeds ${contentLimit} characters for `
            + `${metadataResult.data.kind}: ${sourcePath}`,
        );
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

    const missingIds = KNOWLEDGE_DOCUMENT_IDS.filter((id) => !documents.has(id));
    if (missingIds.length > 0) {
      throw new Error(`Missing knowledge documents: ${missingIds.join(', ')}`);
    }
    const totalCharacters = [...documents.values()].reduce(
      (total, document) => total + countCharacters(document.content),
      0,
    );
    if (totalCharacters > MAX_TOTAL_KNOWLEDGE_CHARACTERS) {
      throw new Error(
        `Total knowledge content exceeds ${MAX_TOTAL_KNOWLEDGE_CHARACTERS} characters`,
      );
    }

    return documents;
  }
}

export function resolveContentDirectory(moduleUrl = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  return basename(moduleDirectory) === 'dist'
    ? join(moduleDirectory, 'content')
    : join(moduleDirectory, '../../content');
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
    .sort(compareOrdinal);
}

function countFrontmatterCharacters(source: string): number {
  if (!source.startsWith('---')) {
    return 0;
  }
  const closingDelimiter = source.indexOf('\n---', 3);
  const frontmatter = closingDelimiter === -1
    ? source
    : source.slice(3, closingDelimiter);
  return countCharacters(frontmatter);
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
