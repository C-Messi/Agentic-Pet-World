import { PetDefinitionSchema, type PetDefinition } from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import {
  createDefaultPetCatalog,
  DEFAULT_PET_DEFINITIONS,
  PetCatalog,
} from './pet-catalog.js';
import { PLAYER_PET_DEFINITION, RESIDENT_DEFINITIONS } from './residents.js';

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return;
  }

  expect(Object.isFrozen(value)).toBe(true);
  for (const nestedValue of Object.values(value)) {
    expectDeeplyFrozen(nestedValue);
  }
}

function mutableClone(definition: PetDefinition): PetDefinition {
  return structuredClone(definition);
}

describe('default pet definitions', () => {
  it('contains exactly one player pet and four residents', () => {
    expect(DEFAULT_PET_DEFINITIONS).toHaveLength(5);
    expect(
      DEFAULT_PET_DEFINITIONS.filter(({ source }) => source === 'player-pet'),
    ).toHaveLength(1);
    expect(
      DEFAULT_PET_DEFINITIONS.filter(({ source }) => source === 'resident'),
    ).toHaveLength(4);
    expect(PLAYER_PET_DEFINITION).toMatchObject({
      id: 'player-cat',
      source: 'player-pet',
      spriteId: 'player-cat',
    });
    expect(
      RESIDENT_DEFINITIONS.map(({ displayName, spriteId }) => [
        displayName,
        spriteId,
      ]),
    ).toEqual([
      ['Mikan', 'orange-cat'],
      ['Huihui', 'gray-cat'],
      ['Lanlan', 'blue-cat'],
      ['Doubao', 'cream-cat'],
    ]);
  });

  it('contains only valid pet definitions with unique public identities', () => {
    for (const definition of DEFAULT_PET_DEFINITIONS) {
      expect(PetDefinitionSchema.parse(definition)).toEqual(definition);
    }

    expect(new Set(DEFAULT_PET_DEFINITIONS.map(({ id }) => id)).size).toBe(5);
    expect(
      new Set(
        DEFAULT_PET_DEFINITIONS.map(({ displayName }) =>
          displayName.trim().toLowerCase(),
        ),
      ).size,
    ).toBe(5);
    expect(
      new Set(DEFAULT_PET_DEFINITIONS.map(({ spriteId }) => spriteId)).size,
    ).toBe(5);
  });

  it('gives every pet a meaningfully distinct personality vector', () => {
    const personalities = DEFAULT_PET_DEFINITIONS.map(({ personality }) =>
      Object.values(personality),
    );

    expect(
      new Set(personalities.map((personality) => JSON.stringify(personality)))
        .size,
    ).toBe(5);
    for (const [index, personality] of personalities.entries()) {
      for (const otherPersonality of personalities.slice(index + 1)) {
        const largestDifference = Math.max(
          ...personality.map((score, scoreIndex) =>
            Math.abs(score - (otherPersonality[scoreIndex] ?? score)),
          ),
        );
        expect(largestDifference).toBeGreaterThanOrEqual(0.2);
      }
    }
  });
});

describe('PetCatalog', () => {
  it('preserves authored order and provides explicit lookup behavior', () => {
    const catalog = createDefaultPetCatalog();

    expect(catalog.list().map(({ id }) => id)).toEqual(
      DEFAULT_PET_DEFINITIONS.map(({ id }) => id),
    );
    expect(catalog.get('resident-mikan')).toEqual(
      DEFAULT_PET_DEFINITIONS.find(({ id }) => id === 'resident-mikan'),
    );
    expect(catalog.get('missing-pet')).toBeUndefined();
    expect(() => catalog.require('missing-pet')).toThrowError(
      'Pet definition not found: missing-pet',
    );
    expect(catalog.playerPet().id).toBe('player-cat');
  });

  it('deep-clones and deep-freezes data returned by every access path', () => {
    const catalog = createDefaultPetCatalog();
    const listedPet = catalog.list()[0];
    const foundPet = catalog.get('resident-mikan');
    const requiredPet = catalog.require('resident-mikan');
    const playerPet = catalog.playerPet();

    expectDeeplyFrozen(catalog.list());
    expectDeeplyFrozen(listedPet);
    expectDeeplyFrozen(foundPet);
    expectDeeplyFrozen(requiredPet);
    expectDeeplyFrozen(playerPet);

    expect(() => {
      (requiredPet.palette as { primary: string }).primary = '#000000';
    }).toThrow(TypeError);
    expect(() => {
      (catalog.list() as PetDefinition[]).push(requiredPet);
    }).toThrow(TypeError);
    expect(catalog.require('resident-mikan').palette.primary).not.toBe(
      '#000000',
    );
  });

  it('isolates catalog state from later mutations to constructor input', () => {
    const definitions = DEFAULT_PET_DEFINITIONS.map(mutableClone);
    const catalog = new PetCatalog(definitions);

    definitions[0]!.displayName = 'Changed outside';
    definitions[0]!.palette.primary = '#000000';
    definitions.push(mutableClone(RESIDENT_DEFINITIONS[0]!));

    expect(catalog.playerPet().displayName).not.toBe('Changed outside');
    expect(catalog.playerPet().palette.primary).not.toBe('#000000');
    expect(catalog.list()).toHaveLength(5);
  });

  it.each([
    [
      'id',
      (definition: PetDefinition) => ({ ...definition, id: 'player-cat' }),
    ],
    [
      'spriteId',
      (definition: PetDefinition) => ({
        ...definition,
        spriteId: 'player-cat',
      }),
    ],
    [
      'display name',
      (definition: PetDefinition) => ({
        ...definition,
        displayName: `  ${PLAYER_PET_DEFINITION.displayName.toUpperCase()}  `,
      }),
    ],
  ])('rejects duplicate %s values', (_field, makeDuplicate) => {
    const duplicate = makeDuplicate(mutableClone(RESIDENT_DEFINITIONS[0]!));

    expect(
      () => new PetCatalog([mutableClone(PLAYER_PET_DEFINITION), duplicate]),
    ).toThrow(/Duplicate pet/);
  });

  it('parses every constructor input through PetDefinitionSchema', () => {
    const invalid = { ...mutableClone(PLAYER_PET_DEFINITION), species: '' };

    expect(
      () => new PetCatalog([invalid, mutableClone(RESIDENT_DEFINITIONS[0]!)]),
    ).toThrow();
  });

  it('requires exactly one player pet and at least one resident', () => {
    expect(
      () => new PetCatalog([mutableClone(RESIDENT_DEFINITIONS[0]!)]),
    ).toThrow('Pet catalog requires exactly one player pet');
    expect(
      () =>
        new PetCatalog([
          mutableClone(PLAYER_PET_DEFINITION),
          {
            ...mutableClone(PLAYER_PET_DEFINITION),
            id: 'second-player',
            displayName: 'Second Player',
            spriteId: 'second-player',
          },
          mutableClone(RESIDENT_DEFINITIONS[0]!),
        ]),
    ).toThrow('Pet catalog requires exactly one player pet');
    expect(() => new PetCatalog([mutableClone(PLAYER_PET_DEFINITION)])).toThrow(
      'Pet catalog requires at least one resident',
    );
  });
});
