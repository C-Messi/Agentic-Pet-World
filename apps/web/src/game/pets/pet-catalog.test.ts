import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PetSpriteManifestSchema, type PetDefinition } from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import { PetAssetCatalog } from './pet-catalog';

const definition: PetDefinition = {
  schemaVersion: 'pet-definition.v1',
  id: 'player-cat',
  displayName: 'Sunny',
  source: 'player-pet',
  species: 'cat',
  spriteId: 'player-cat',
  palette: { primary: '#E9953D', secondary: '#FFF0C9', accent: '#5A4636' },
  personality: {
    curiosity: 0.5,
    sociability: 0.5,
    playfulness: 0.5,
    creativity: 0.5,
  },
  voice: { style: 'warm', catchphrases: [] },
  interests: [],
  publicBio: 'A friendly town explorer.',
};

function manifest(spriteId = 'player-cat') {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), `public/assets/pets/${spriteId}/manifest.json`),
      'utf8',
    ),
  ) as unknown;
}

describe('PetAssetCatalog', () => {
  it('validates a manifest before exposing a derived image path', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(manifest())),
    ) as typeof fetch;
    const catalog = new PetAssetCatalog(fetcher);

    const [asset] = await catalog.load([definition]);

    expect(fetcher).toHaveBeenCalledWith(
      '/assets/pets/player-cat/manifest.json',
    );
    expect(asset?.imageUrl).toBe('/assets/pets/player-cat/pet-atlas.png');
    expect(PetSpriteManifestSchema.parse(asset?.manifest).rows).toBe(7);
    expect(catalog.animationKey('player-cat', 'happy')).toBe(
      'player-cat:happy',
    );
  });

  it('rejects duplicate texture keys before fetching manifests', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const catalog = new PetAssetCatalog(fetcher);
    const duplicate = {
      ...definition,
      id: 'resident-copy',
      source: 'resident' as const,
    };

    await expect(catalog.load([definition, duplicate])).rejects.toThrow(
      'Duplicate pet texture key',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not invoke a Phaser loader until all manifests are valid', async () => {
    const invalid = {
      ...(manifest() as object),
      frame: { width: 48, height: 32 },
    };
    const catalog = new PetAssetCatalog(
      vi.fn(async () => new Response(JSON.stringify(invalid))) as typeof fetch,
    );
    const loader = { spritesheet: vi.fn() };

    await expect(catalog.load([definition])).rejects.toThrow();
    catalog.preload(loader);
    expect(loader.spritesheet).not.toHaveBeenCalled();
  });
});
