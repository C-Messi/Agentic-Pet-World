import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const roomDirectory = join(root, 'apps/web/public/assets/room');
const catDirectory = join(root, 'apps/web/public/assets/cat');

const palette = {
  ink: '#3a3029',
  shadow: '#6a4935',
  wood: '#a96f48',
  woodLight: '#c98c5e',
  wall: '#d9c99d',
  moss: '#657a4c',
  mossLight: '#879866',
  sunflower: '#e8b94c',
  coral: '#c96f62',
  sky: '#73a7bd',
  skyLight: '#b9d8d8',
  cream: '#f2dfb0',
  orange: '#d97b3d',
  orangeDark: '#9e4f2f',
  white: '#fff4d6',
};

function rgba(hex, alpha = 255) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
}

function canvas(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  return {
    width,
    height,
    pixels,
    pixel(x, y, color) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
      pixels.set(color, offset);
    },
    rect(x, y, rectangleWidth, rectangleHeight, color) {
      for (let py = y; py < y + rectangleHeight; py += 1) {
        for (let px = x; px < x + rectangleWidth; px += 1) this.pixel(px, py, color);
      }
    },
    outline(x, y, rectangleWidth, rectangleHeight, color) {
      this.rect(x, y, rectangleWidth, 1, color);
      this.rect(x, y + rectangleHeight - 1, rectangleWidth, 1, color);
      this.rect(x, y, 1, rectangleHeight, color);
      this.rect(x + rectangleWidth - 1, y, 1, rectangleHeight, color);
    },
  };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodePng(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const outputOffset = y * (image.width * 4 + 1);
    scanlines[outputOffset] = 0;
    scanlines.set(
      image.pixels.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      outputOffset + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePng(path, image) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(image));
}

function drawRoomBackground() {
  const image = canvas(384, 256);
  const ink = rgba(palette.ink);
  image.rect(0, 0, 384, 256, ink);
  image.rect(8, 8, 368, 44, rgba(palette.wall));
  image.rect(8, 52, 368, 196, rgba(palette.wood));
  image.rect(8, 47, 368, 5, rgba(palette.shadow));

  for (let x = 16; x < 376; x += 32) {
    image.rect(x, 16, 14, 3, rgba(palette.mossLight));
    image.rect(x + 8, 29, 14, 3, rgba(palette.moss));
  }
  for (let y = 52; y < 248; y += 16) {
    image.rect(8, y, 368, 1, rgba(palette.shadow));
    const offset = (y / 16) % 2 === 0 ? 0 : 24;
    for (let x = 8 + offset; x < 376; x += 48) image.rect(x, y, 1, 16, rgba(palette.shadow));
    image.rect(9, y + 2, 366, 1, rgba(palette.woodLight));
  }

  image.rect(112, 104, 160, 96, rgba(palette.cream));
  image.rect(120, 112, 144, 80, rgba(palette.moss));
  image.rect(128, 120, 128, 64, rgba(palette.mossLight));
  image.outline(112, 104, 160, 96, ink);
  for (let x = 128; x < 256; x += 16) {
    image.rect(x, 120, 4, 4, rgba(palette.sunflower));
    image.rect(x + 8, 180, 4, 4, rgba(palette.coral));
  }

  image.rect(8, 244, 368, 4, rgba(palette.ink));
  return image;
}

function drawFurniture() {
  const image = canvas(256, 128);
  const colors = Object.fromEntries(Object.entries(palette).map(([key, value]) => [key, rgba(value)]));
  const origin = (index) => ({ x: (index % 4) * 64, y: Math.floor(index / 4) * 64 });

  {
    const { x, y } = origin(0);
    image.rect(x + 6, y + 17, 52, 36, colors.ink);
    image.rect(x + 9, y + 20, 46, 30, colors.coral);
    image.rect(x + 11, y + 22, 18, 11, colors.cream);
    image.rect(x + 31, y + 22, 22, 26, colors.orangeDark);
    image.rect(x + 10, y + 50, 4, 7, colors.shadow);
    image.rect(x + 50, y + 50, 4, 7, colors.shadow);
  }
  {
    const { x, y } = origin(1);
    image.rect(x + 5, y + 23, 54, 29, colors.ink);
    image.rect(x + 8, y + 16, 48, 31, colors.sky);
    image.rect(x + 10, y + 20, 21, 20, colors.skyLight);
    image.rect(x + 33, y + 20, 21, 20, colors.coral);
    image.rect(x + 8, y + 45, 48, 9, colors.moss);
  }
  {
    const { x, y } = origin(2);
    image.rect(x + 9, y + 5, 46, 50, colors.ink);
    image.rect(x + 13, y + 9, 38, 42, colors.skyLight);
    image.rect(x + 15, y + 11, 34, 19, colors.sky);
    image.rect(x + 30, y + 9, 3, 42, colors.white);
    image.rect(x + 13, y + 30, 38, 3, colors.white);
    image.rect(x + 7, y + 53, 50, 5, colors.moss);
  }
  {
    const { x, y } = origin(3);
    image.rect(x + 15, y + 30, 34, 18, colors.ink);
    image.rect(x + 18, y + 32, 28, 13, colors.sky);
    image.rect(x + 22, y + 27, 20, 8, colors.cream);
    image.rect(x + 25, y + 31, 14, 4, colors.sunflower);
    image.rect(x + 20, y + 48, 4, 6, colors.shadow);
    image.rect(x + 40, y + 48, 4, 6, colors.shadow);
  }
  {
    const { x, y } = origin(4);
    image.rect(x + 7, y + 4, 50, 56, colors.ink);
    image.rect(x + 10, y + 7, 44, 50, colors.shadow);
    for (let shelf = 0; shelf < 3; shelf += 1) {
      const shelfY = y + 11 + shelf * 15;
      image.rect(x + 12, shelfY + 10, 40, 3, colors.woodLight);
      for (let book = 0; book < 5; book += 1) {
        const bookColors = [colors.coral, colors.sky, colors.sunflower, colors.moss, colors.cream];
        image.rect(x + 13 + book * 7, shelfY, 5, 10, bookColors[(book + shelf) % 5]);
      }
    }
  }
  {
    const { x, y } = origin(5);
    image.rect(x + 11, y + 28, 42, 27, colors.ink);
    image.rect(x + 14, y + 31, 36, 21, colors.sunflower);
    image.rect(x + 18, y + 20, 8, 13, colors.coral);
    image.rect(x + 28, y + 17, 7, 16, colors.sky);
    image.rect(x + 38, y + 22, 8, 11, colors.moss);
    for (let xOffset = 18; xOffset < 48; xOffset += 8) image.rect(x + xOffset, y + 35, 3, 14, colors.cream);
  }
  {
    const { x, y } = origin(6);
    image.rect(x + 11, y + 3, 42, 58, colors.ink);
    image.rect(x + 15, y + 7, 34, 50, colors.coral);
    image.rect(x + 18, y + 11, 28, 23, colors.sky);
    image.rect(x + 21, y + 14, 22, 17, colors.ink);
    image.rect(x + 24, y + 17, 16, 11, colors.skyLight);
    image.rect(x + 19, y + 39, 8, 8, colors.sunflower);
    image.rect(x + 35, y + 39, 5, 5, colors.moss);
    image.rect(x + 17, y + 52, 30, 4, colors.shadow);
  }
  return image;
}

function drawCatFrame(image, frameIndex, state, phase) {
  const originX = (frameIndex % 4) * 32;
  const originY = Math.floor(frameIndex / 4) * 32;
  const color = Object.fromEntries(Object.entries(palette).map(([key, value]) => [key, rgba(value)]));
  const bob = state === 'walk' || state === 'happy' ? phase % 2 : 0;
  const x = originX;
  const y = originY + bob;

  if (state === 'sleep') {
    image.rect(x + 6, y + 18, 21, 8, color.ink);
    image.rect(x + 8, y + 16, 17, 9, color.orange);
    image.rect(x + 20, y + 14, 7, 8, color.orange);
    image.rect(x + 21, y + 13, 2, 3, color.orangeDark);
    image.rect(x + 25, y + 13, 2, 3, color.orangeDark);
    image.rect(x + 21, y + 18, 2, 1, color.ink);
    image.rect(x + 24, y + 18, 2, 1, color.ink);
    image.rect(x + 7, y + 23, 8, 2, color.cream);
    return;
  }

  if (state === 'sit') {
    image.rect(x + 9, y + 17, 15, 11, color.ink);
    image.rect(x + 11, y + 15, 11, 12, color.orange);
  } else {
    image.rect(x + 8, y + 17, 18, 9, color.ink);
    image.rect(x + 10, y + 16, 14, 9, color.orange);
  }

  image.rect(x + 11, y + 8, 13, 11, color.ink);
  image.rect(x + 12, y + 7, 4, 5, color.orangeDark);
  image.rect(x + 20, y + 7, 4, 5, color.orangeDark);
  image.rect(x + 12, y + 10, 11, 8, color.orange);
  image.rect(x + 14, y + 13, 7, 5, color.cream);
  image.rect(x + 14, y + 11, 2, 2, color.ink);
  image.rect(x + 20, y + 11, 2, 2, color.ink);
  image.pixel(x + 18, y + 14, color.coral);

  const tailY = y + 18 + (phase % 2) * 2;
  image.rect(x + 4, tailY, 7, 3, color.ink);
  image.rect(x + 5, tailY, 6, 2, color.orangeDark);
  image.rect(x + 11, y + 24, 4, 4, color.cream);
  image.rect(x + 20, y + 24, 4, 4, color.cream);

  if (state === 'walk') {
    image.rect(x + 8 + (phase % 2) * 4, y + 25, 5, 3, color.orangeDark);
    image.rect(x + 20 - (phase % 2) * 4, y + 25, 5, 3, color.orangeDark);
  } else if (state === 'happy') {
    image.rect(x + 14, y + 11, 3, 1, color.ink);
    image.rect(x + 20, y + 11, 3, 1, color.ink);
    image.rect(x + 17, y + 16, 3, 1, color.coral);
  } else if (state === 'curious') {
    image.rect(x + 13, y + 10, 3, 4, color.skyLight);
    image.rect(x + 20, y + 10, 3, 4, color.skyLight);
    image.pixel(x + 25, y + 6 - (phase % 2), color.sunflower);
  } else if (state === 'confused') {
    image.rect(x + 14, y + 10, 3, 1, color.ink);
    image.rect(x + 20, y + 12, 3, 1, color.ink);
    image.rect(x + 25, y + 5, 2, 2, color.coral);
    image.pixel(x + 26, y + 3, color.coral);
  }
}

function drawCatAtlas() {
  const states = ['idle', 'walk', 'sit', 'sleep', 'happy', 'curious', 'confused'];
  const image = canvas(128, 224);
  states.forEach((state, row) => {
    for (let phase = 0; phase < 4; phase += 1) drawCatFrame(image, row * 4 + phase, state, phase);
  });
  return image;
}

mkdirSync(roomDirectory, { recursive: true });
mkdirSync(catDirectory, { recursive: true });
writePng(join(roomDirectory, 'room-background.png'), drawRoomBackground());
writePng(join(roomDirectory, 'furniture-atlas.png'), drawFurniture());
writePng(join(catDirectory, 'cat-atlas.png'), drawCatAtlas());

writeFileSync(
  join(roomDirectory, 'manifest.json'),
  `${JSON.stringify(
    {
      pixelArt: true,
      room: { image: 'room-background.png', width: 384, height: 256 },
      furniture: {
        image: 'furniture-atlas.png',
        frame: { width: 64, height: 64 },
        columns: 4,
        frames: { bed: 0, sofa: 1, window: 2, 'food-bowl': 3, bookshelf: 4, 'toy-basket': 5, arcade: 6 },
      },
    },
    null,
    2,
  )}\n`,
);

const animations = Object.fromEntries(
  ['idle', 'walk', 'sit', 'sleep', 'happy', 'curious', 'confused'].map((state, row) => [
    state,
    { frames: [0, 1, 2, 3].map((column) => row * 4 + column), frameRate: state === 'walk' ? 9 : 5 },
  ]),
);
writeFileSync(
  join(catDirectory, 'manifest.json'),
  `${JSON.stringify(
    {
      pixelArt: true,
      image: 'cat-atlas.png',
      frame: { width: 32, height: 32 },
      columns: 4,
      animations,
    },
    null,
    2,
  )}\n`,
);

console.log('Generated original pixel assets: room 384x256, furniture 256x128, cat 128x224.');
