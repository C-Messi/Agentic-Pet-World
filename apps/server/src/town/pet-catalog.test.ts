import { PetDefinitionSchema, type PetDefinition } from '@cat-house/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createDefaultPetCatalog,
  DEFAULT_PET_DEFINITIONS,
  type DeepReadonly,
  PetCatalog,
  type ReadonlyPetDefinition,
} from './pet-catalog.js';
import { createAuthoredPetDefinitions } from './residents.js';

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return;
  }

  expect(Object.isFrozen(value)).toBe(true);
  for (const nestedValue of Object.values(value)) {
    expectDeeplyFrozen(nestedValue);
  }
}

function mutableClone(definition: ReadonlyPetDefinition): PetDefinition {
  return structuredClone(definition) as PetDefinition;
}

function defaultPlayerPet(): ReadonlyPetDefinition {
  return DEFAULT_PET_DEFINITIONS.find(({ source }) => source === 'player-pet')!;
}

function defaultResident(): ReadonlyPetDefinition {
  return DEFAULT_PET_DEFINITIONS.find(({ source }) => source === 'resident')!;
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
    expect(defaultPlayerPet()).toMatchObject({
      id: 'player-cat',
      source: 'player-pet',
      spriteId: 'player-cat',
    });
    expect(
      DEFAULT_PET_DEFINITIONS.filter(({ source }) => source === 'resident').map(
        ({ displayName, spriteId }) => [displayName, spriteId],
      ),
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

  it('is deeply frozen and isolated from mutable authored factory results', () => {
    expectDeeplyFrozen(DEFAULT_PET_DEFINITIONS);
    expect(() => {
      (DEFAULT_PET_DEFINITIONS[0]!.palette as { primary: string }).primary =
        '#000000';
    }).toThrow(TypeError);

    const authoredDefinitions = createAuthoredPetDefinitions();
    authoredDefinitions[0]!.displayName = 'Changed authored name';
    authoredDefinitions[0]!.palette.primary = '#000000';
    authoredDefinitions.push(mutableClone(defaultResident()));

    const catalog = createDefaultPetCatalog();
    expect(catalog.list()).toHaveLength(5);
    expect(catalog.playerPet().displayName).toBe('Sunny');
    expect(catalog.playerPet().palette.primary).toBe('#E9953D');
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
      (catalog.list() as PetDefinition[]).push(requiredPet as PetDefinition);
    }).toThrow(TypeError);
    expect(catalog.require('resident-mikan').palette.primary).not.toBe(
      '#000000',
    );
  });

  it('exposes recursively readonly result types', () => {
    const catalog = createDefaultPetCatalog();

    expectTypeOf(catalog.get('resident-mikan')).toEqualTypeOf<
      ReadonlyPetDefinition | undefined
    >();
    expectTypeOf(
      catalog.require('resident-mikan'),
    ).toEqualTypeOf<ReadonlyPetDefinition>();
    expectTypeOf(catalog.list()).toEqualTypeOf<
      readonly ReadonlyPetDefinition[]
    >();
    expectTypeOf(catalog.playerPet()).toEqualTypeOf<ReadonlyPetDefinition>();
    expectTypeOf(DEFAULT_PET_DEFINITIONS).toEqualTypeOf<
      readonly ReadonlyPetDefinition[]
    >();
    expectTypeOf(catalog.playerPet().palette).toEqualTypeOf<
      DeepReadonly<PetDefinition['palette']>
    >();
    expectTypeOf(catalog.playerPet().voice.catchphrases).toEqualTypeOf<
      readonly string[]
    >();
    expectTypeOf(catalog.playerPet().interests).toEqualTypeOf<
      readonly string[]
    >();
  });

  it('isolates catalog state from later mutations to constructor input', () => {
    const definitions = DEFAULT_PET_DEFINITIONS.map(mutableClone);
    const catalog = new PetCatalog(definitions);

    definitions[0]!.displayName = 'Changed outside';
    definitions[0]!.palette.primary = '#000000';
    definitions.push(mutableClone(defaultResident()));

    expect(catalog.playerPet().displayName).not.toBe('Changed outside');
    expect(catalog.playerPet().palette.primary).not.toBe('#000000');
    expect(catalog.list()).toHaveLength(5);
  });

  it.each([
    [
      'id',
      (definition: PetDefinition) => ({ ...definition, id: 'player-cat' }),
      'Duplicate pet id: player-cat',
    ],
    [
      'sprite ID',
      (definition: PetDefinition) => ({
        ...definition,
        spriteId: 'player-cat',
      }),
      'Duplicate pet sprite ID: player-cat',
    ],
    [
      'display name',
      (definition: PetDefinition) => ({
        ...definition,
        displayName: `  ${defaultPlayerPet().displayName.toUpperCase()}  `,
      }),
      'Duplicate pet display name: SUNNY',
    ],
  ])('rejects duplicate %s values', (_field, makeDuplicate, expectedError) => {
    const duplicate = makeDuplicate(mutableClone(defaultResident()));

    expect(
      () => new PetCatalog([mutableClone(defaultPlayerPet()), duplicate]),
    ).toThrowError(expectedError);
  });

  it('rejects canonically equivalent display names', () => {
    const playerPet = {
      ...mutableClone(defaultPlayerPet()),
      displayName: 'Caf\u00e9',
    };
    const resident = {
      ...mutableClone(defaultResident()),
      displayName: 'Cafe\u0301',
    };

    expect(() => new PetCatalog([playerPet, resident])).toThrowError(
      'Duplicate pet display name: Cafe\u0301',
    );
  });

  it('parses every constructor input through PetDefinitionSchema', () => {
    const invalid = { ...mutableClone(defaultPlayerPet()), species: '' };

    expect(
      () => new PetCatalog([invalid, mutableClone(defaultResident())]),
    ).toThrow();
  });

  it('requires exactly one player pet and at least one resident', () => {
    expect(() => new PetCatalog([mutableClone(defaultResident())])).toThrow(
      'Pet catalog requires exactly one player pet',
    );
    expect(
      () =>
        new PetCatalog([
          mutableClone(defaultPlayerPet()),
          {
            ...mutableClone(defaultPlayerPet()),
            id: 'second-player',
            displayName: 'Second Player',
            spriteId: 'second-player',
          },
          mutableClone(defaultResident()),
        ]),
    ).toThrow('Pet catalog requires exactly one player pet');
    expect(() => new PetCatalog([mutableClone(defaultPlayerPet())])).toThrow(
      'Pet catalog requires at least one resident',
    );
  });
});
