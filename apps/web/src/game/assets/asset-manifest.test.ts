import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import { PetSpriteManifestSchema } from '@cat-house/shared';

import catManifest from '../../../public/assets/cat/manifest.json';
import roomManifest from '../../../public/assets/room/manifest.json';
import townManifest from '../../../public/assets/town/manifest.json';

const spriteIds = [
  'player-cat',
  'orange-cat',
  'gray-cat',
  'blue-cat',
  'cream-cat',
] as const;

const townFrameNames = [
  'gate',
  'plaza',
  'fortune-pavilion',
  'market-stall-1',
  'market-stall-2',
  'market-stall-3',
  'market-stall-4',
  'garden',
  'arcade-house',
  'bench',
  'flower-arch',
  'notice-board',
  'lantern-row',
  'tiny-stage',
  'water',
  'bridge',
  'path',
  'sign-gate',
  'sign-fortune',
  'sign-market',
  'sign-garden',
  'sign-build',
  'sign-arcade',
  'sign-plaza',
  'build-plot',
  'recipe-board',
  'fortune-banner',
  'market-crate',
  'fortune-roof-left',
  'fortune-roof-right',
  'fortune-base-left',
  'fortune-base-right',
  'greenhouse-left',
  'greenhouse-right',
  'greenhouse-door',
  'market-awning-red',
  'market-awning-yellow',
  'market-awning-blue',
  'arcade-roof-left',
  'arcade-roof-right',
  'arcade-base-left',
  'arcade-base-right',
  'workshop-left',
  'workshop-right',
  'workshop-yard',
  'gate-roof-left',
  'gate-roof-right',
  'bridge-rail',
  'tree-green',
  'tree-blossom',
  'tree-canopy-foreground',
  'hedge-horizontal',
  'hedge-vertical',
  'fence-horizontal',
  'fence-vertical',
  'lamp-post',
  'bench-detailed',
  'flower-bed',
  'planter',
  'market-crates-detailed',
  'dock',
  'plaza-fountain-detailed',
  'plaza-banner',
  'shoreline-reeds',
] as const;

function pngInfo(path: string) {
  const bytes = readFileSync(resolve(process.cwd(), path));
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT')
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(idat));
  return {
    signature: bytes.subarray(0, 8).toString('hex'),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
    bytes,
    pixels,
  };
}

function pngFramePixels(
  png: ReturnType<typeof pngInfo>,
  frameIndex: number,
  frameWidth: number,
  frameHeight: number,
  columns: number,
) {
  const frame = Buffer.alloc(frameWidth * frameHeight * 4);
  const originX = (frameIndex % columns) * frameWidth;
  const originY = Math.floor(frameIndex / columns) * frameHeight;
  const stride = png.width * 4 + 1;
  for (let y = 0; y < frameHeight; y += 1) {
    const sourceStart = (originY + y) * stride + 1 + originX * 4;
    png.pixels.copy(
      frame,
      y * frameWidth * 4,
      sourceStart,
      sourceStart + frameWidth * 4,
    );
  }
  return frame;
}

function expectFrameRegionTransparent(
  png: ReturnType<typeof pngInfo>,
  frameIndex: number,
  frameWidth: number,
  frameHeight: number,
  columns: number,
  region: { x: number; y: number; width: number; height: number },
) {
  const pixels = pngFramePixels(
    png,
    frameIndex,
    frameWidth,
    frameHeight,
    columns,
  );
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      expect(pixels[(y * frameWidth + x) * 4 + 3]).toBe(0);
    }
  }
}

describe('generated pixel asset manifests', () => {
  it('keeps canonical cat states in stable equal-sized atlas cells', () => {
    expect(catManifest.image).toBe('cat-atlas.png');
    expect(catManifest.frame).toEqual({ width: 32, height: 32 });
    expect(catManifest.columns).toBe(4);
    expect(Object.keys(catManifest.animations)).toEqual([
      'idle',
      'walk',
      'sit',
      'sleep',
      'happy',
      'curious',
      'confused',
    ]);
    expect(
      Object.values(catManifest.animations).every(
        ({ frames }) => frames.length === 4,
      ),
    ).toBe(true);
  });

  it('defines a fixed room and furniture frame for each registered object', () => {
    expect(roomManifest.room).toEqual({
      image: 'room-background.png',
      width: 384,
      height: 256,
    });
    expect(roomManifest.furniture.frame).toEqual({ width: 64, height: 64 });
    expect(Object.keys(roomManifest.furniture.frames)).toEqual([
      'bed',
      'sofa',
      'rug',
      'window',
      'food-bowl',
      'bookshelf',
      'toy-basket',
      'arcade',
    ]);
  });

  it('emits five schema-valid RGBA pet atlases with transparent unused pixels', () => {
    for (const spriteId of spriteIds) {
      const directory = `public/assets/pets/${spriteId}`;
      const manifest = PetSpriteManifestSchema.parse(
        JSON.parse(
          readFileSync(
            resolve(process.cwd(), `${directory}/manifest.json`),
            'utf8',
          ),
        ),
      );
      const png = pngInfo(`${directory}/${manifest.image}`);
      expect(png).toMatchObject({
        signature: '89504e470d0a1a0a',
        width: 128,
        height: 224,
        colorType: 6,
      });
      const alpha = Array.from({ length: 128 * 224 }, (_, index) => {
        const x = index % 128;
        const y = Math.floor(index / 128);
        return png.pixels[y * (128 * 4 + 1) + 1 + x * 4 + 3];
      });
      expect(alpha.some((value) => value === 0)).toBe(true);
      expect(alpha.some((value) => value === 255)).toBe(true);
      expect(png.bytes.length).toBeGreaterThan(500);
    }
  });

  it('keeps the town atlas and background dimensions synchronized with its manifest', () => {
    expect(
      pngInfo(`public/assets/town/${townManifest.background.image}`),
    ).toMatchObject({
      width: townManifest.background.width,
      height: townManifest.background.height,
    });
    expect(
      pngInfo(`public/assets/town/${townManifest.atlas.image}`),
    ).toMatchObject({
      width: townManifest.atlas.frame.width * townManifest.atlas.columns,
      height: townManifest.atlas.frame.height * townManifest.atlas.rows,
    });
    expect(townManifest.atlas).toMatchObject({
      frame: { width: 64, height: 64 },
      columns: 8,
      rows: 8,
    });
    expect(Object.keys(townManifest.atlas.frames)).toEqual(townFrameNames);
    expect(Object.values(townManifest.atlas.frames)).toEqual(
      townFrameNames.map((_, index) => index),
    );
  });

  it('draws every appended town frame as distinct bounded pixel art', () => {
    const { frame, columns } = townManifest.atlas;
    const png = pngInfo(`public/assets/town/${townManifest.atlas.image}`);
    const hashes = townFrameNames.slice(28).map((_, offset) => {
      const pixels = pngFramePixels(
        png,
        offset + 28,
        frame.width,
        frame.height,
        columns,
      );
      const alpha = Array.from(
        { length: frame.width * frame.height },
        (_, index) => pixels[index * 4 + 3],
      );
      const visiblePixels = alpha.filter((value) => value === 255).length;
      expect(alpha.some((value) => value === 0)).toBe(true);
      expect(alpha.some((value) => value === 255)).toBe(true);
      expect(visiblePixels).toBeGreaterThanOrEqual(64);
      expect(visiblePixels).toBeLessThanOrEqual(3_072);
      return createHash('sha256').update(pixels).digest('hex');
    });
    expect(new Set(hashes).size).toBe(36);
  });

  it.each([
    {
      name: 'fence-horizontal into fence-vertical',
      frameIndex: 54,
      region: { x: 0, y: 20, width: 7, height: 36 },
    },
    {
      name: 'fence-vertical into plaza-banner',
      frameIndex: 62,
      region: { x: 16, y: 0, width: 34, height: 7 },
    },
    {
      name: 'dock into plaza-fountain-detailed',
      frameIndex: 61,
      region: { x: 0, y: 27, width: 2, height: 24 },
    },
  ])('does not spill $name', ({ frameIndex, region }) => {
    const { frame, columns } = townManifest.atlas;
    const png = pngInfo(`public/assets/town/${townManifest.atlas.image}`);
    expectFrameRegionTransparent(
      png,
      frameIndex,
      frame.width,
      frame.height,
      columns,
      region,
    );
  });

  it('uses local manifest image names only', () => {
    const images = [townManifest.background.image, townManifest.atlas.image];
    for (const spriteId of spriteIds) {
      const raw = JSON.parse(
        readFileSync(
          resolve(
            process.cwd(),
            `public/assets/pets/${spriteId}/manifest.json`,
          ),
          'utf8',
        ),
      ) as { image: string };
      images.push(raw.image);
    }
    expect(
      images.every((image) => !image.includes('/') && !image.includes('..')),
    ).toBe(true);
  });
});
