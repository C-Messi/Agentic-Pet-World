import { describe, expect, it } from 'vitest';
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
    expect(Object.keys(townManifest.atlas.frames)).toEqual(
      expect.arrayContaining([
        'gate',
        'fortune-pavilion',
        'market-stall-4',
        'arcade-house',
        'bridge',
      ]),
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
