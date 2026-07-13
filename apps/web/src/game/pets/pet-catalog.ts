import {
  PET_ANIMATION_NAMES,
  PetDefinitionSchema,
  PetSpriteManifestSchema,
  type PetDefinition,
  type PetSpriteManifest,
} from '@cat-house/shared';

export type PetAsset = {
  definition: PetDefinition;
  manifest: PetSpriteManifest;
  textureKey: string;
  imageUrl: string;
};

export interface SpriteSheetLoader {
  spritesheet(
    key: string,
    url: string,
    config: { frameWidth: number; frameHeight: number },
  ): unknown;
}

export class PetAssetCatalog {
  readonly #fetcher: typeof fetch;
  readonly #assets = new Map<string, PetAsset>();

  constructor(fetcher: typeof fetch = fetch) {
    this.#fetcher = fetcher;
  }

  async load(
    definitions: readonly PetDefinition[],
  ): Promise<readonly PetAsset[]> {
    const parsed = definitions.map((definition) =>
      PetDefinitionSchema.parse(definition),
    );
    const petIds = new Set<string>();
    const textureKeys = new Set<string>();

    for (const definition of parsed) {
      if (petIds.has(definition.id))
        throw new Error(`Duplicate pet ID: ${definition.id}`);
      if (textureKeys.has(definition.spriteId)) {
        throw new Error(`Duplicate pet texture key: ${definition.spriteId}`);
      }
      petIds.add(definition.id);
      textureKeys.add(definition.spriteId);
    }

    const assets = await Promise.all(
      parsed.map(async (definition): Promise<PetAsset> => {
        const baseUrl = `/assets/pets/${definition.spriteId}`;
        const response = await this.#fetcher(`${baseUrl}/manifest.json`);
        if (!response.ok)
          throw new Error(
            `Unable to load pet manifest: ${definition.spriteId}`,
          );
        const manifest = PetSpriteManifestSchema.parse(await response.json());
        return {
          definition,
          manifest,
          textureKey: definition.spriteId,
          imageUrl: `${baseUrl}/${manifest.image}`,
        };
      }),
    );

    this.#assets.clear();
    for (const asset of assets) this.#assets.set(asset.definition.id, asset);
    return assets;
  }

  list(): readonly PetAsset[] {
    return [...this.#assets.values()];
  }

  require(petId: string): PetAsset {
    const asset = this.#assets.get(petId);
    if (asset === undefined) throw new Error(`Pet asset not loaded: ${petId}`);
    return asset;
  }

  preload(loader: SpriteSheetLoader): void {
    for (const asset of this.#assets.values()) {
      loader.spritesheet(asset.textureKey, asset.imageUrl, {
        frameWidth: asset.manifest.frame.width,
        frameHeight: asset.manifest.frame.height,
      });
    }
  }

  animationKey(
    petId: string,
    animation: (typeof PET_ANIMATION_NAMES)[number],
  ): string {
    this.require(petId);
    return `${petId}:${animation}`;
  }
}
