import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import {
  PetSpriteManifestSchema,
  TOWN_GRID,
  TOWN_ZONE_LAYOUT,
} from '@cat-house/shared';

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

// Decoded RGBA for the original frame contract (indices 0-27) at b3ab761.
const originalTownFramesSha256 =
  '4edf04fda911d61e5f124adc29a9f18103bdf4f2221fa5656cb85b0c5e70aaff';

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
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const stride = width * 4 + 1;
  for (let y = 0; y < height; y += 1) {
    const filter = pixels[y * stride];
    if (filter !== 0)
      throw new Error(`Unsupported PNG filter ${filter} on row ${y}: ${path}`);
  }
  return {
    signature: bytes.subarray(0, 8).toString('hex'),
    width,
    height,
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

type Rgb = readonly [red: number, green: number, blue: number];

function pngPixel(
  png: ReturnType<typeof pngInfo>,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  const offset = y * (png.width * 4 + 1) + 1 + x * 4;
  return [
    png.pixels[offset] ?? 0,
    png.pixels[offset + 1] ?? 0,
    png.pixels[offset + 2] ?? 0,
    png.pixels[offset + 3] ?? 0,
  ];
}

function regionPixels(
  png: ReturnType<typeof pngInfo>,
  region: { x: number; y: number; width: number; height: number },
  step = 1,
): Rgb[] {
  const pixels: Rgb[] = [];
  for (let y = region.y; y < region.y + region.height; y += step) {
    for (let x = region.x; x < region.x + region.width; x += step) {
      const [red, green, blue] = pngPixel(png, x, y);
      pixels.push([red, green, blue]);
    }
  }
  return pixels;
}

function pixelRatio(
  pixels: readonly Rgb[],
  predicate: (pixel: Rgb) => boolean,
) {
  return pixels.filter(predicate).length / pixels.length;
}

function averageLuminance(pixels: readonly Rgb[]) {
  return (
    pixels.reduce(
      (total, [red, green, blue]) =>
        total + red * 0.2126 + green * 0.7152 + blue * 0.0722,
      0,
    ) / pixels.length
  );
}

function rgbKey([red, green, blue]: Rgb) {
  return `${red},${green},${blue}`;
}

const isTreeGreen = ([red, green, blue]: Rgb) =>
  green >= red + 8 && green >= blue + 12 && red < 125 && green < 150;
const isWaterBlue = ([red, green, blue]: Rgb) =>
  green >= red + 24 && blue >= green && blue >= red + 48;
const isWalkableGround = ([red, green, blue]: Rgb) =>
  (red >= 145 && green >= 115 && blue >= 72 && blue <= 175) ||
  (red >= 105 && red <= 190 && green >= 75 && green <= 155 && blue < 115);
const isPaving = ([red, green, blue]: Rgb) =>
  red >= 150 &&
  red <= 225 &&
  green >= 135 &&
  green <= 210 &&
  blue >= 105 &&
  blue <= 175;

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

  it('emits an opaque detailed RGBA town background', () => {
    const png = pngInfo(`public/assets/town/${townManifest.background.image}`);
    expect(png).toMatchObject({ width: 640, height: 360, colorType: 6 });

    const sampledColors = new Set<string>();
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const [red, green, blue, alpha] = pngPixel(png, x, y);
        expect(alpha).toBe(255);
        if (x % 4 === 0 && y % 4 === 0)
          sampledColors.add(rgbKey([red, green, blue]));
      }
    }
    expect(sampledColors.size).toBeGreaterThan(32);
  });

  it('layers a dark tree line above the lighter village terrain', () => {
    const png = pngInfo(`public/assets/town/${townManifest.background.image}`);
    const treeLine = regionPixels(
      png,
      { x: 0, y: 0, width: 640, height: 48 },
      2,
    );
    const villageGrass = regionPixels(
      png,
      { x: 0, y: 56, width: 640, height: 56 },
      2,
    );

    expect(pixelRatio(treeLine, isTreeGreen)).toBeGreaterThan(0.62);
    expect(new Set(treeLine.map(rgbKey)).size).toBeGreaterThan(3);
    expect(
      averageLuminance(villageGrass) - averageLuminance(treeLine),
    ).toBeGreaterThan(24);
  });

  it('keeps the lower shore blue outside the central bridge', () => {
    const png = pngInfo(`public/assets/town/${townManifest.background.image}`);
    const water = [
      ...regionPixels(png, { x: 0, y: 286, width: 240, height: 74 }, 2),
      ...regionPixels(png, { x: 400, y: 286, width: 240, height: 74 }, 2),
    ];

    expect(pixelRatio(water, isWaterBlue)).toBeGreaterThan(0.82);
  });

  it('draws a warm central bridge through the lower water', () => {
    const png = pngInfo(`public/assets/town/${townManifest.background.image}`);
    const bridge = regionPixels(
      png,
      { x: 256, y: 276, width: 128, height: 84 },
      2,
    );

    expect(pixelRatio(bridge, isWalkableGround)).toBeGreaterThan(0.62);
    expect(pixelRatio(bridge, isWaterBlue)).toBeLessThan(0.18);
    expect(new Set(bridge.map(rgbKey)).size).toBeGreaterThan(7);
  });

  it('keeps every shared town entrance on visible path or district ground', () => {
    const png = pngInfo(`public/assets/town/${townManifest.background.image}`);
    for (const [zoneId, zone] of Object.entries(TOWN_ZONE_LAYOUT)) {
      const centerX = zone.entrance.x * TOWN_GRID.tileSize + 16;
      const centerY = zone.entrance.y * TOWN_GRID.tileSize + 16;
      const entrance = regionPixels(png, {
        x: centerX - 6,
        y: centerY - 6,
        width: 13,
        height: 13,
      });
      expect(pixelRatio(entrance, isWalkableGround), zoneId).toBeGreaterThan(
        0.72,
      );
    }
  });

  it('textures central plaza paving distinctly from surrounding grass', () => {
    const png = pngInfo(`public/assets/town/${townManifest.background.image}`);
    const plaza = regionPixels(
      png,
      { x: 224, y: 128, width: 192, height: 128 },
      4,
    );
    const surroundingGrass = [
      ...regionPixels(png, { x: 192, y: 128, width: 32, height: 128 }, 4),
      ...regionPixels(png, { x: 416, y: 128, width: 32, height: 128 }, 4),
    ];

    expect(pixelRatio(plaza, isPaving)).toBeGreaterThan(0.68);
    expect(new Set(plaza.map(rgbKey)).size).toBeGreaterThan(8);
    expect(
      Math.abs(averageLuminance(plaza) - averageLuminance(surroundingGrass)),
    ).toBeGreaterThan(16);
  });

  it('composites district ground pads over the road network', () => {
    const png = pngInfo(`public/assets/town/${townManifest.background.image}`);
    const [red, green, blue] = pngPixel(png, 180, 105);

    expect(rgbKey([red, green, blue])).toBe('135,157,104');
  });

  it('uses the approved named background layer order', () => {
    const generatorSource = readFileSync(
      resolve(process.cwd(), '../../scripts/generate-pixel-assets.mjs'),
      'utf8',
    );
    const declaration = generatorSource.match(
      /const townBackgroundLayerOrder = Object\.freeze\(\[([\s\S]*?)\]\);/,
    );

    expect(
      declaration,
      'missing townBackgroundLayerOrder contract',
    ).not.toBeNull();
    const layerNames = Array.from(
      (declaration?.[1] ?? '').matchAll(/'([^']+)'/g),
      (match) => match[1],
    );
    expect(layerNames).toEqual([
      'base-grass',
      'tree-line',
      'roads',
      'district-pads',
      'plaza',
      'water',
      'shoreline-reeds',
      'bridge',
      'decorations',
    ]);
    expect(generatorSource).toContain(
      'for (const layerName of townBackgroundLayerOrder)',
    );
    expect(generatorSource).toContain('layers[layerName]();');
  });

  it('keeps original town frames pixel-identical', () => {
    const { frame, columns } = townManifest.atlas;
    const png = pngInfo(`public/assets/town/${townManifest.atlas.image}`);
    const pixels = Buffer.concat(
      Array.from({ length: 28 }, (_, frameIndex) =>
        pngFramePixels(png, frameIndex, frame.width, frame.height, columns),
      ),
    );
    expect(createHash('sha256').update(pixels).digest('hex')).toBe(
      originalTownFramesSha256,
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
    {
      name: 'shoreline reeds past the atlas edge',
      frameIndex: 63,
      region: { x: 63, y: 20, width: 1, height: 32 },
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
