import { PetDefinitionSchema, type PetDefinition } from '@cat-house/shared';

import { createAuthoredPetDefinitions } from './residents.js';

export type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ReadonlyPetDefinition = DeepReadonly<PetDefinition>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value) as DeepReadonly<T>;
}

function duplicateError(field: string, value: string): Error {
  return new Error(`Duplicate pet ${field}: ${value}`);
}

export class PetCatalog {
  readonly #definitions: readonly ReadonlyPetDefinition[];
  readonly #byId: ReadonlyMap<string, ReadonlyPetDefinition>;
  readonly #playerPet: ReadonlyPetDefinition;

  constructor(definitions: readonly PetDefinition[]) {
    const parsedDefinitions = definitions.map((definition) =>
      deepFreeze(PetDefinitionSchema.parse(structuredClone(definition))),
    );
    const ids = new Set<string>();
    const displayNames = new Set<string>();
    const spriteIds = new Set<string>();

    for (const definition of parsedDefinitions) {
      if (ids.has(definition.id)) {
        throw duplicateError('id', definition.id);
      }
      ids.add(definition.id);

      const normalizedDisplayName = definition.displayName
        .trim()
        .normalize('NFC')
        .toLowerCase();
      if (displayNames.has(normalizedDisplayName)) {
        throw duplicateError('display name', definition.displayName);
      }
      displayNames.add(normalizedDisplayName);

      if (spriteIds.has(definition.spriteId)) {
        throw duplicateError('sprite ID', definition.spriteId);
      }
      spriteIds.add(definition.spriteId);
    }

    const playerPets = parsedDefinitions.filter(
      ({ source }) => source === 'player-pet',
    );
    if (playerPets.length !== 1) {
      throw new Error('Pet catalog requires exactly one player pet');
    }
    if (!parsedDefinitions.some(({ source }) => source === 'resident')) {
      throw new Error('Pet catalog requires at least one resident');
    }

    this.#definitions = deepFreeze(parsedDefinitions);
    this.#byId = new Map(
      parsedDefinitions.map((definition) => [definition.id, definition]),
    );
    this.#playerPet = playerPets[0]!;
  }

  get(id: string): ReadonlyPetDefinition | undefined {
    return this.#byId.get(id);
  }

  require(id: string): ReadonlyPetDefinition {
    const definition = this.get(id);
    if (definition === undefined) {
      throw new Error(`Pet definition not found: ${id}`);
    }
    return definition;
  }

  list(): readonly ReadonlyPetDefinition[] {
    return this.#definitions;
  }

  playerPet(): ReadonlyPetDefinition {
    return this.#playerPet;
  }
}

export const DEFAULT_PET_DEFINITIONS: readonly ReadonlyPetDefinition[] =
  deepFreeze(
    createAuthoredPetDefinitions().map((definition) =>
      PetDefinitionSchema.parse(structuredClone(definition)),
    ),
  );

export function createDefaultPetCatalog(): PetCatalog {
  return new PetCatalog(createAuthoredPetDefinitions());
}
