import { describe, expect, it } from 'vitest';

import {
  PET_ANIMATION_NAMES,
  PetDefinitionSchema,
  PetSpriteManifestSchema,
} from './pet.js';

const validPet = {
  schemaVersion: 'pet-definition.v1',
  id: 'resident-mock',
  displayName: 'Mock',
  source: 'resident',
  species: 'cat',
  spriteId: 'mock-orange',
  palette: {
    primary: '#F29A38',
    secondary: '#FFF3D6',
    accent: '#356A8A',
  },
  personality: {
    curiosity: 0.9,
    sociability: 0.75,
    playfulness: 0.8,
    creativity: 0.65,
  },
  voice: {
    style: 'Warm, curious, and concise',
    catchphrases: ['Let me inspect that.', 'Interesting!'],
  },
  interests: ['windows', 'tiny games', 'sunbeams'],
  publicBio: 'A curious resident who enjoys exploring the shared room.',
} as const;

const animations = Object.fromEntries(
  PET_ANIMATION_NAMES.map((name, row) => [
    name,
    { frames: [row * 4, row * 4 + 1, row * 4 + 2, row * 4 + 3], frameRate: 6 },
  ]),
);

const validManifest = {
  schemaVersion: 'pet-sprite.v1',
  pixelArt: true,
  image: 'mock-orange.png',
  frame: { width: 32, height: 32 },
  columns: 4,
  rows: 7,
  anchor: { x: 0.5, y: 0.78 },
  body: { width: 20, height: 24, offsetX: 6, offsetY: 8 },
  animations,
};

describe('pet definitions', () => {
  it('accepts a valid resident pet', () => {
    expect(PetDefinitionSchema.parse(validPet)).toEqual(validPet);
  });

  it('rejects duplicate interests', () => {
    expect(() =>
      PetDefinitionSchema.parse({
        ...validPet,
        interests: ['windows', 'sunbeams', 'windows'],
      }),
    ).toThrow();
  });

  it('rejects an unknown source', () => {
    expect(() => PetDefinitionSchema.parse({ ...validPet, source: 'imported' })).toThrow();
  });

  it('rejects invalid hex colors', () => {
    expect(() =>
      PetDefinitionSchema.parse({
        ...validPet,
        palette: { ...validPet.palette, primary: '#F90' },
      }),
    ).toThrow();
  });

  it('rejects personality scores outside the normalized range', () => {
    expect(() =>
      PetDefinitionSchema.parse({
        ...validPet,
        personality: { ...validPet.personality, curiosity: 1.01 },
      }),
    ).toThrow();
    expect(() =>
      PetDefinitionSchema.parse({
        ...validPet,
        personality: { ...validPet.personality, sociability: -0.01 },
      }),
    ).toThrow();
  });

  it('enforces bounded unique interests and catchphrases', () => {
    expect(() =>
      PetDefinitionSchema.parse({
        ...validPet,
        interests: ['one', 'two', 'three', 'four', 'five', 'six'],
      }),
    ).toThrow();
    expect(() =>
      PetDefinitionSchema.parse({
        ...validPet,
        voice: { ...validPet.voice, catchphrases: ['Again.', 'Again.'] },
      }),
    ).toThrow();
  });
});

describe('pet sprite manifests', () => {
  it('accepts a complete 4-by-7 sprite atlas manifest', () => {
    expect(PetSpriteManifestSchema.parse(validManifest)).toEqual(validManifest);
  });

  it('rejects a missing animation row', () => {
    const missingAnimation = { ...animations };
    delete missingAnimation.confused;

    expect(() =>
      PetSpriteManifestSchema.parse({ ...validManifest, animations: missingAnimation }),
    ).toThrow();
  });

  it('rejects non-32px frames', () => {
    expect(() =>
      PetSpriteManifestSchema.parse({
        ...validManifest,
        frame: { width: 64, height: 32 },
      }),
    ).toThrow();
  });

  it('rejects traversal and directories in image names', () => {
    expect(() =>
      PetSpriteManifestSchema.parse({ ...validManifest, image: '../mock-orange.png' }),
    ).toThrow();
    expect(() =>
      PetSpriteManifestSchema.parse({ ...validManifest, image: 'pets/mock-orange.png' }),
    ).toThrow();
  });

  it('rejects frame indices outside the 28-frame atlas', () => {
    expect(() =>
      PetSpriteManifestSchema.parse({
        ...validManifest,
        animations: {
          ...animations,
          confused: { frames: [24, 25, 26, 28], frameRate: 6 },
        },
      }),
    ).toThrow();
  });

  it('rejects duplicate animation frames and unknown animation keys', () => {
    expect(() =>
      PetSpriteManifestSchema.parse({
        ...validManifest,
        animations: {
          ...animations,
          idle: { frames: [0, 1, 1, 3], frameRate: 6 },
        },
      }),
    ).toThrow();
    expect(() =>
      PetSpriteManifestSchema.parse({
        ...validManifest,
        animations: { ...animations, dance: { frames: [0, 1, 2, 3], frameRate: 6 } },
      }),
    ).toThrow();
  });

  it('keeps the body rectangle inside the frame', () => {
    expect(() =>
      PetSpriteManifestSchema.parse({
        ...validManifest,
        body: { width: 20, height: 24, offsetX: 13, offsetY: 8 },
      }),
    ).toThrow();
    expect(() =>
      PetSpriteManifestSchema.parse({
        ...validManifest,
        body: { width: 20, height: 24, offsetX: 6, offsetY: 9 },
      }),
    ).toThrow();
  });
});
