import { PetDefinitionSchema, type PetDefinition } from '@cat-house/shared';

import { PLAYER_PET_DEFINITION, RESIDENT_DEFINITIONS } from './residents.js';

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value);
}

function duplicateError(field: string, value: string): Error {
  return new Error(`Duplicate pet ${field}: ${value}`);
}

export class PetCatalog {
  readonly #definitions: readonly PetDefinition[];
  readonly #byId: ReadonlyMap<string, PetDefinition>;
  readonly #playerPet: PetDefinition;

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

      const normalizedDisplayName = definition.displayName.trim().toLowerCase();
      if (displayNames.has(normalizedDisplayName)) {
        throw duplicateError('display name', definition.displayName);
      }
      displayNames.add(normalizedDisplayName);

      if (spriteIds.has(definition.spriteId)) {
        throw duplicateError('sprite id', definition.spriteId);
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

  get(id: string): PetDefinition | undefined {
    return this.#byId.get(id);
  }

  require(id: string): PetDefinition {
    const definition = this.get(id);
    if (definition === undefined) {
      throw new Error(`Pet definition not found: ${id}`);
    }
    return definition;
  }

  list(): readonly PetDefinition[] {
    return this.#definitions;
  }

  playerPet(): PetDefinition {
    return this.#playerPet;
  }
}

export const DEFAULT_PET_DEFINITIONS: readonly PetDefinition[] = deepFreeze(
  [PLAYER_PET_DEFINITION, ...RESIDENT_DEFINITIONS].map((definition) =>
    PetDefinitionSchema.parse(structuredClone(definition)),
  ),
);

export function createDefaultPetCatalog(): PetCatalog {
  return new PetCatalog(DEFAULT_PET_DEFINITIONS);
}
