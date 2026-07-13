import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const roomDirectory = join(root, 'apps/web/public/assets/room');
const catDirectory = join(root, 'apps/web/public/assets/cat');
const townDirectory = join(root, 'apps/web/public/assets/town');
const petsDirectory = join(root, 'apps/web/public/assets/pets');

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
  let writeBoundary;
  return {
    width,
    height,
    pixels,
    pixel(x, y, color) {
      const pixelX = Math.floor(x);
      const pixelY = Math.floor(y);
      if (
        writeBoundary &&
        (pixelX < writeBoundary.x ||
          pixelY < writeBoundary.y ||
          pixelX >= writeBoundary.x + writeBoundary.width ||
          pixelY >= writeBoundary.y + writeBoundary.height)
      ) {
        throw new Error(
          `Town frame "${writeBoundary.name}" attempted to draw outside its cell at ${pixelX},${pixelY}`,
        );
      }
      if (pixelX < 0 || pixelY < 0 || pixelX >= width || pixelY >= height)
        return;
      const offset = (pixelY * width + pixelX) * 4;
      pixels.set(color, offset);
    },
    rect(x, y, rectangleWidth, rectangleHeight, color) {
      for (let py = y; py < y + rectangleHeight; py += 1) {
        for (let px = x; px < x + rectangleWidth; px += 1)
          this.pixel(px, py, color);
      }
    },
    outline(x, y, rectangleWidth, rectangleHeight, color) {
      this.rect(x, y, rectangleWidth, 1, color);
      this.rect(x, y + rectangleHeight - 1, rectangleWidth, 1, color);
      this.rect(x, y, 1, rectangleHeight, color);
      this.rect(x + rectangleWidth - 1, y, 1, rectangleHeight, color);
    },
    beginWriteBoundary(x, y, boundaryWidth, boundaryHeight, name) {
      if (writeBoundary)
        throw new Error('Canvas write boundary is already active');
      writeBoundary = {
        x,
        y,
        width: boundaryWidth,
        height: boundaryHeight,
        name,
      };
    },
    endWriteBoundary() {
      writeBoundary = undefined;
    },
  };
}

function checker(image, x, y, width, height, first, second, size = 6) {
  for (let row = 0; row < height; row += size) {
    for (let column = 0; column < width; column += size) {
      image.rect(
        x + column,
        y + row,
        Math.min(size, width - column),
        Math.min(size, height - row),
        (Math.floor(column / size) + Math.floor(row / size)) % 2 === 0
          ? first
          : second,
      );
    }
  }
}

function roof(image, x, y, width, height, side, fill, outline, highlight) {
  for (let row = 0; row < height; row += 1) {
    const inset = Math.floor((height - row - 1) / 4) * 3;
    const start = side === 'left' ? x + inset : x;
    const end = side === 'left' ? x + width : x + width - inset;
    const isEdge = row === 0 || row >= height - 3;
    image.rect(start, y + row, end - start, 1, isEdge ? outline : fill);
    if (!isEdge && row % 7 === 2) {
      const highlightStart = side === 'left' ? start + 3 : start;
      const highlightWidth = Math.max(0, end - highlightStart - 3);
      image.rect(highlightStart, y + row, highlightWidth, 2, highlight);
    }
  }
}

function tree(image, x, y, canopy, canopyLight, trunk, outline, blossoms) {
  image.rect(x + 26, y + 31, 13, 27, outline);
  image.rect(x + 29, y + 32, 7, 24, trunk);
  image.rect(x + 12, y + 18, 42, 29, outline);
  image.rect(x + 18, y + 10, 30, 39, outline);
  image.rect(x + 8, y + 25, 48, 16, outline);
  image.rect(x + 15, y + 20, 36, 23, canopy);
  image.rect(x + 21, y + 13, 24, 32, canopy);
  image.rect(x + 11, y + 28, 42, 10, canopy);
  image.rect(x + 21, y + 18, 12, 8, canopyLight);
  image.rect(x + 14, y + 29, 8, 6, canopyLight);
  image.rect(x + 39, y + 27, 9, 7, canopyLight);
  blossoms.forEach(({ offsetX, offsetY, color }) => {
    image.rect(x + offsetX, y + offsetY, 4, 4, color);
    image.rect(x + offsetX + 1, y + offsetY - 2, 2, 8, color);
  });
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
  for (const byte of buffer)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
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
    for (let x = 8 + offset; x < 376; x += 48)
      image.rect(x, y, 1, 16, rgba(palette.shadow));
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
  const colors = Object.fromEntries(
    Object.entries(palette).map(([key, value]) => [key, rgba(value)]),
  );
  const origin = (index) => ({
    x: (index % 4) * 64,
    y: Math.floor(index / 4) * 64,
  });

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
        const bookColors = [
          colors.coral,
          colors.sky,
          colors.sunflower,
          colors.moss,
          colors.cream,
        ];
        image.rect(
          x + 13 + book * 7,
          shelfY,
          5,
          10,
          bookColors[(book + shelf) % 5],
        );
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
    for (let xOffset = 18; xOffset < 48; xOffset += 8)
      image.rect(x + xOffset, y + 35, 3, 14, colors.cream);
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
  {
    const { x, y } = origin(7);
    image.rect(x + 5, y + 12, 54, 40, colors.ink);
    image.rect(x + 8, y + 15, 48, 34, colors.cream);
    image.rect(x + 12, y + 19, 40, 26, colors.moss);
    image.rect(x + 16, y + 23, 32, 18, colors.mossLight);
    for (let xOffset = 16; xOffset < 48; xOffset += 8) {
      image.rect(x + xOffset, y + 23, 3, 3, colors.sunflower);
      image.rect(x + xOffset + 4, y + 38, 3, 3, colors.coral);
    }
  }
  return image;
}

function drawCatFrame(image, frameIndex, state, phase) {
  const originX = (frameIndex % 4) * 32;
  const originY = Math.floor(frameIndex / 4) * 32;
  const color = Object.fromEntries(
    Object.entries(palette).map(([key, value]) => [key, rgba(value)]),
  );
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
  const states = [
    'idle',
    'walk',
    'sit',
    'sleep',
    'happy',
    'curious',
    'confused',
  ];
  const image = canvas(128, 224);
  states.forEach((state, row) => {
    for (let phase = 0; phase < 4; phase += 1)
      drawCatFrame(image, row * 4 + phase, state, phase);
  });
  return image;
}

function drawPetFrame(image, frameIndex, state, phase, pet) {
  const originX = (frameIndex % 4) * 32;
  const originY = Math.floor(frameIndex / 4) * 32;
  const ink = rgba(palette.ink);
  const primary = rgba(pet.primary);
  const secondary = rgba(pet.secondary);
  const accent = rgba(pet.accent);
  const bob = state === 'walk' || state === 'happy' ? phase % 2 : 0;
  const x = originX;
  const y = originY + bob;

  if (state === 'sleep') {
    image.rect(x + 6, y + 18, 21, 8, ink);
    image.rect(x + 8, y + 16, 17, 9, primary);
    image.rect(x + 20, y + 14, 7, 8, primary);
    image.rect(x + 22, y + 18, 4, 1, ink);
    image.rect(x + 8, y + 23, 8, 2, secondary);
    return;
  }

  image.rect(
    x + 8,
    y + (state === 'sit' ? 17 : 18),
    18,
    state === 'sit' ? 10 : 8,
    ink,
  );
  image.rect(
    x + 10,
    y + (state === 'sit' ? 16 : 17),
    14,
    state === 'sit' ? 11 : 8,
    primary,
  );
  image.rect(x + 11, y + 8, 13, 11, ink);
  const earHeight = pet.ears === 'tall' ? 6 : 4;
  image.rect(x + 12, y + 8 - earHeight + 2, 4, earHeight, primary);
  image.rect(x + 20, y + 8 - earHeight + 2, 4, earHeight, primary);
  image.rect(x + 12, y + 10, 11, 8, primary);
  image.rect(x + 14, y + 13, 7, 5, secondary);
  image.rect(x + 14, y + 11, 2, 2, ink);
  image.rect(x + 20, y + 11, 2, 2, ink);
  image.pixel(x + 18, y + 14, accent);

  const tailY = y + 18 + (phase % 2) * (pet.tail === 'bushy' ? 1 : 2);
  image.rect(
    x + (pet.tail === 'short' ? 6 : 4),
    tailY,
    pet.tail === 'short' ? 5 : 7,
    3,
    ink,
  );
  image.rect(
    x + (pet.tail === 'short' ? 7 : 5),
    tailY,
    pet.tail === 'short' ? 4 : 6,
    2,
    accent,
  );
  if (pet.marking === 'stripe') {
    image.rect(x + 16, y + 8, 2, 4, accent);
    image.rect(x + 11, y + 19, 4, 2, accent);
  } else if (pet.marking === 'mask') {
    image.rect(x + 13, y + 10, 4, 4, accent);
    image.rect(x + 19, y + 10, 4, 4, accent);
  } else if (pet.marking === 'spot') {
    image.rect(x + 18, y + 19, 4, 3, accent);
  }

  image.rect(x + 11, y + 24, 4, 4, secondary);
  image.rect(x + 20, y + 24, 4, 4, secondary);
  if (state === 'happy') image.rect(x + 16, y + 16, 4, 1, accent);
  if (state === 'curious')
    image.pixel(x + 26, y + 6 - (phase % 2), rgba(palette.sunflower));
  if (state === 'confused') {
    image.rect(x + 26, y + 4, 2, 2, accent);
    image.pixel(x + 27, y + 2, accent);
  }
}

function drawPetAtlas(pet) {
  const image = canvas(128, 224);
  const states = [
    'idle',
    'walk',
    'sit',
    'sleep',
    'happy',
    'curious',
    'confused',
  ];
  states.forEach((state, row) => {
    for (let phase = 0; phase < 4; phase += 1) {
      drawPetFrame(image, row * 4 + phase, state, phase, pet);
    }
  });
  return image;
}

function drawTownBackground() {
  const image = canvas(640, 360);
  const ink = rgba(palette.ink);
  const grass = rgba('#8FB86F');
  const grassDark = rgba('#7BA45F');
  const path = rgba('#D9C58C');
  const pathLight = rgba('#EFDEAB');
  const pathEdge = rgba('#B99A68');
  image.rect(0, 0, 640, 360, grass);

  for (let y = 10; y < 346; y += 24) {
    for (let x = y % 48 === 10 ? 12 : 36; x < 628; x += 48)
      image.rect(x, y, 5, 4, grassDark);
  }

  image.rect(26, 28, 178, 132, rgba('#7FAE69'));
  image.outline(26, 28, 178, 132, rgba('#5F844C'));
  image.rect(448, 28, 184, 154, rgba('#A8B971'));
  image.outline(448, 28, 184, 154, rgba('#6E8449'));
  image.rect(28, 162, 190, 92, rgba('#73A867'));
  image.outline(28, 162, 190, 92, rgba('#537F4C'));
  image.rect(240, 118, 160, 132, rgba('#C7B77D'));
  image.outline(240, 118, 160, 132, ink);
  image.rect(258, 232, 150, 112, rgba('#A68D68'));
  image.outline(258, 232, 150, 112, rgba('#725A45'));
  image.rect(446, 192, 164, 128, rgba('#697B8F'));
  image.outline(446, 192, 164, 128, rgba('#465569'));
  image.rect(2, 228, 126, 118, rgba('#8B6B4B'));
  image.outline(2, 228, 126, 118, rgba('#594330'));

  image.rect(0, 276, 640, 84, rgba('#5F9FB4'));
  image.rect(0, 270, 640, 8, rgba('#6B8B69'));
  image.rect(0, 292, 640, 3, rgba('#B9D8D8'));
  image.rect(0, 326, 640, 2, rgba('#4B8194'));
  for (let x = 18; x < 640; x += 54)
    image.rect(x, 306 + (x % 3), 16, 2, rgba('#86C2CF'));

  image.rect(286, 0, 68, 276, path);
  image.rect(0, 154, 640, 58, path);
  image.rect(60, 212, 50, 64, path);
  image.rect(354, 208, 54, 88, path);
  image.rect(512, 178, 54, 76, path);
  image.outline(286, 0, 68, 276, pathEdge);
  image.outline(0, 154, 640, 58, pathEdge);
  image.rect(292, 0, 4, 276, pathLight);
  image.rect(0, 160, 640, 4, pathLight);
  image.rect(246, 124, 148, 120, rgba('#D7C98F'));
  image.outline(246, 124, 148, 120, ink);

  image.rect(54, 270, 72, 90, rgba(palette.wood));
  for (let y = 276; y < 360; y += 12)
    image.rect(54, y, 72, 2, rgba(palette.woodLight));
  image.outline(54, 270, 72, 90, ink);

  for (let x = 48; x < 200; x += 30) {
    image.rect(x, 56, 6, 6, rgba(palette.sunflower));
    image.rect(x + 12, 114, 5, 5, rgba(palette.coral));
  }
  for (let x = 472; x < 620; x += 34) {
    image.rect(x, 58, 22, 8, rgba('#D66B5F'));
    image.rect(x + 4, 70, 14, 6, rgba('#F4D47C'));
  }
  for (let x = 52; x < 198; x += 26) {
    image.rect(x, 188, 5, 5, rgba('#F2D25B'));
    image.rect(x + 9, 224, 5, 5, rgba('#E38480'));
  }
  for (let x = 278; x < 392; x += 24)
    image.rect(x, 248, 20, 16, rgba('#8C6B4B'));
  for (let x = 470; x < 594; x += 28)
    image.rect(x, 222, 14, 8, rgba('#90B8D8'));
  return image;
}

function drawTownAtlas() {
  const image = canvas(512, 512);
  const colors = Object.fromEntries(
    Object.entries(palette).map(([key, value]) => [key, rgba(value)]),
  );
  const tile = (index) => ({
    x: (index % 8) * 64,
    y: Math.floor(index / 8) * 64,
  });
  const names = [
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
  ];
  names.forEach((name, index) => {
    const { x, y } = tile(index);
    image.beginWriteBoundary(x, y, 64, 64, name);
    if (name === 'water') image.rect(x, y, 64, 64, colors.sky);
    else if (name === 'path') image.rect(x, y, 64, 64, colors.cream);
    else if (name.startsWith('sign-')) {
      image.rect(x + 28, y + 20, 7, 38, colors.ink);
      image.rect(x + 10, y + 8, 44, 30, colors.ink);
      image.rect(
        x + 13,
        y + 11,
        38,
        24,
        name === 'sign-plaza' ? colors.skyLight : colors.sunflower,
      );
      image.rect(x + 18, y + 20, 28, 3, colors.ink);
    } else if (name === 'gate') {
      image.rect(x + 8, y + 48, 48, 6, colors.ink);
      image.rect(x + 12, y + 18, 8, 36, colors.wood);
      image.rect(x + 44, y + 18, 8, 36, colors.wood);
      image.rect(x + 7, y + 12, 50, 8, colors.ink);
      image.rect(x + 10, y + 8, 44, 9, colors.coral);
      image.rect(x + 20, y + 22, 24, 5, colors.sunflower);
    } else if (name === 'plaza') {
      image.rect(x + 13, y + 42, 38, 10, colors.ink);
      image.rect(x + 16, y + 39, 32, 10, colors.cream);
      image.rect(x + 20, y + 28, 24, 12, colors.ink);
      image.rect(x + 23, y + 25, 18, 13, colors.sky);
      image.rect(x + 29, y + 14, 6, 14, colors.skyLight);
      image.rect(x + 25, y + 12, 14, 4, colors.white);
    } else if (name === 'fortune-pavilion') {
      image.rect(x + 9, y + 43, 46, 9, colors.ink);
      image.rect(x + 13, y + 25, 38, 20, colors.coral);
      image.rect(x + 17, y + 29, 30, 12, colors.cream);
      image.rect(x + 5, y + 18, 54, 8, colors.ink);
      image.rect(x + 9, y + 12, 46, 9, colors.sunflower);
      image.rect(x + 21, y + 31, 8, 10, colors.sky);
      image.rect(x + 36, y + 31, 8, 10, colors.moss);
    } else if (name === 'garden') {
      image.rect(x + 7, y + 35, 50, 17, colors.ink);
      image.rect(x + 10, y + 38, 44, 11, colors.moss);
      image.rect(x + 18, y + 20, 28, 15, colors.sky);
      image.rect(x + 20, y + 22, 24, 11, colors.skyLight);
      for (let offset = 13; offset < 54; offset += 10) {
        image.rect(x + offset, y + 31, 4, 4, colors.sunflower);
        image.rect(x + offset + 3, y + 43, 3, 3, colors.coral);
      }
    } else if (name === 'arcade-house') {
      image.rect(x + 7, y + 19, 50, 36, colors.ink);
      image.rect(x + 11, y + 23, 42, 28, rgba('#4F5F83'));
      image.rect(x + 16, y + 28, 18, 12, colors.sky);
      image.rect(x + 18, y + 30, 14, 8, colors.ink);
      image.rect(x + 38, y + 31, 6, 6, colors.sunflower);
      image.rect(x + 46, y + 35, 4, 4, colors.coral);
      image.rect(x + 14, y + 14, 36, 8, colors.sunflower);
    } else if (name.includes('stall')) {
      image.rect(x + 7, y + 22, 50, 35, colors.ink);
      image.rect(x + 10, y + 25, 44, 29, index % 2 ? colors.coral : colors.sky);
      image.rect(x + 5, y + 13, 54, 12, colors.cream);
      image.rect(x + 14, y + 30, 10, 10, colors.sunflower);
      image.rect(x + 32, y + 32, 14, 8, colors.mossLight);
    } else if (name === 'build-plot') {
      image.rect(x + 7, y + 30, 50, 24, colors.ink);
      image.rect(x + 10, y + 33, 44, 18, colors.wood);
      image.rect(x + 15, y + 18, 34, 14, colors.ink);
      image.rect(x + 18, y + 21, 28, 8, colors.cream);
      image.rect(x + 12, y + 10, 6, 22, colors.woodLight);
      image.rect(x + 46, y + 10, 6, 22, colors.woodLight);
      image.rect(x + 22, y + 42, 20, 5, colors.sunflower);
    } else if (name === 'recipe-board') {
      image.rect(x + 13, y + 8, 38, 48, colors.ink);
      image.rect(x + 16, y + 11, 32, 42, colors.cream);
      image.rect(x + 21, y + 18, 22, 3, colors.coral);
      image.rect(x + 21, y + 27, 18, 3, colors.moss);
      image.rect(x + 21, y + 36, 24, 3, colors.sky);
    } else if (name === 'fortune-banner') {
      image.rect(x + 12, y + 9, 40, 46, colors.ink);
      image.rect(x + 16, y + 13, 32, 38, colors.coral);
      image.rect(x + 23, y + 20, 18, 18, colors.sunflower);
      image.rect(x + 29, y + 26, 6, 6, colors.white);
    } else if (name === 'market-crate') {
      image.rect(x + 10, y + 32, 44, 22, colors.ink);
      image.rect(x + 13, y + 35, 38, 16, colors.wood);
      image.rect(x + 20, y + 21, 8, 12, colors.coral);
      image.rect(x + 32, y + 18, 9, 15, colors.sunflower);
      image.rect(x + 42, y + 24, 7, 9, colors.mossLight);
    } else if (name === 'fortune-roof-left') {
      roof(
        image,
        x + 3,
        y + 13,
        61,
        24,
        'left',
        colors.coral,
        colors.ink,
        colors.sunflower,
      );
      image.rect(x + 4, y + 37, 60, 5, colors.ink);
      image.rect(x + 11, y + 42, 8, 10, colors.sunflower);
    } else if (name === 'fortune-roof-right') {
      roof(
        image,
        x,
        y + 13,
        61,
        24,
        'right',
        colors.coral,
        colors.ink,
        colors.sunflower,
      );
      image.rect(x, y + 37, 60, 5, colors.ink);
      image.rect(x + 44, y + 42, 8, 10, colors.sunflower);
      image.rect(x + 27, y + 8, 10, 7, colors.white);
    } else if (name === 'fortune-base-left') {
      image.rect(x + 5, y + 7, 59, 51, colors.ink);
      image.rect(x + 9, y + 11, 55, 43, colors.cream);
      image.rect(x + 18, y + 18, 31, 23, colors.ink);
      image.rect(x + 21, y + 21, 25, 17, colors.skyLight);
      image.rect(x + 9, y + 46, 55, 8, colors.wood);
      image.rect(x + 54, y + 12, 5, 33, colors.coral);
    } else if (name === 'fortune-base-right') {
      image.rect(x, y + 7, 59, 51, colors.ink);
      image.rect(x, y + 11, 55, 43, colors.cream);
      image.rect(x + 10, y + 18, 25, 36, colors.ink);
      image.rect(x + 14, y + 22, 17, 32, colors.coral);
      image.rect(x + 18, y + 30, 4, 4, colors.sunflower);
      image.rect(x, y + 46, 55, 8, colors.wood);
      image.rect(x + 42, y + 18, 9, 15, colors.sunflower);
    } else if (name === 'greenhouse-left') {
      image.rect(x + 5, y + 24, 59, 34, colors.ink);
      image.rect(x + 9, y + 27, 55, 27, colors.skyLight);
      image.rect(x + 19, y + 17, 45, 9, colors.cream);
      image.rect(x + 27, y + 10, 37, 8, colors.sky);
      image.rect(x + 18, y + 25, 4, 31, colors.cream);
      image.rect(x + 40, y + 25, 4, 31, colors.cream);
      image.rect(x + 10, y + 43, 54, 4, colors.cream);
      image.rect(x + 13, y + 48, 8, 6, colors.mossLight);
    } else if (name === 'greenhouse-right') {
      image.rect(x, y + 24, 59, 34, colors.ink);
      image.rect(x, y + 27, 55, 27, colors.skyLight);
      image.rect(x, y + 17, 45, 9, colors.cream);
      image.rect(x, y + 10, 37, 8, colors.sky);
      image.rect(x + 18, y + 25, 4, 31, colors.cream);
      image.rect(x + 40, y + 25, 4, 31, colors.cream);
      image.rect(x, y + 43, 54, 4, colors.cream);
      image.rect(x + 35, y + 48, 10, 6, colors.moss);
    } else if (name === 'greenhouse-door') {
      image.rect(x + 14, y + 8, 36, 50, colors.ink);
      image.rect(x + 18, y + 12, 28, 42, colors.skyLight);
      image.rect(x + 30, y + 12, 4, 42, colors.cream);
      image.rect(x + 18, y + 30, 28, 4, colors.cream);
      image.rect(x + 39, y + 37, 4, 4, colors.sunflower);
      image.rect(x + 10, y + 54, 44, 5, colors.moss);
    } else if (name.startsWith('market-awning-')) {
      const awningColor = name.endsWith('red')
        ? colors.coral
        : name.endsWith('yellow')
          ? colors.sunflower
          : colors.sky;
      image.rect(x + 4, y + 16, 56, 7, colors.ink);
      checker(image, x + 7, y + 19, 50, 16, awningColor, colors.cream, 7);
      image.rect(x + 7, y + 35, 50, 4, colors.ink);
      for (let offset = 7; offset < 57; offset += 14) {
        image.rect(x + offset, y + 39, 8, 7, awningColor);
        image.rect(x + offset + 2, y + 46, 4, 3, colors.ink);
      }
    } else if (name === 'arcade-roof-left') {
      roof(
        image,
        x + 4,
        y + 14,
        60,
        25,
        'left',
        rgba('#4F5F83'),
        colors.ink,
        colors.sky,
      );
      image.rect(x + 11, y + 37, 53, 6, colors.ink);
      image.rect(x + 32, y + 21, 28, 8, colors.sunflower);
    } else if (name === 'arcade-roof-right') {
      roof(
        image,
        x,
        y + 14,
        60,
        25,
        'right',
        rgba('#4F5F83'),
        colors.ink,
        colors.sky,
      );
      image.rect(x, y + 37, 53, 6, colors.ink);
      image.rect(x + 4, y + 21, 28, 8, colors.sunflower);
      image.rect(x + 14, y + 23, 4, 4, colors.coral);
    } else if (name === 'arcade-base-left') {
      image.rect(x + 5, y + 7, 59, 51, colors.ink);
      image.rect(x + 9, y + 11, 55, 43, rgba('#4F5F83'));
      image.rect(x + 16, y + 18, 40, 23, colors.ink);
      image.rect(x + 20, y + 22, 32, 15, colors.sky);
      image.rect(x + 24, y + 25, 24, 9, colors.skyLight);
      image.rect(x + 9, y + 48, 55, 6, colors.coral);
    } else if (name === 'arcade-base-right') {
      image.rect(x, y + 7, 59, 51, colors.ink);
      image.rect(x, y + 11, 55, 43, rgba('#4F5F83'));
      image.rect(x + 10, y + 18, 25, 36, colors.ink);
      image.rect(x + 14, y + 22, 17, 32, colors.shadow);
      image.rect(x + 17, y + 27, 11, 11, colors.skyLight);
      image.rect(x + 40, y + 23, 7, 7, colors.sunflower);
      image.rect(x + 47, y + 33, 5, 5, colors.coral);
    } else if (name === 'workshop-left') {
      image.rect(x + 5, y + 11, 59, 47, colors.ink);
      image.rect(x + 9, y + 15, 55, 39, colors.wood);
      for (let plank = 19; plank < 54; plank += 10)
        image.rect(x + 9, y + plank, 55, 2, colors.woodLight);
      image.rect(x + 17, y + 21, 28, 22, colors.ink);
      image.rect(x + 21, y + 25, 20, 14, colors.skyLight);
      image.rect(x + 52, y + 16, 5, 37, colors.shadow);
    } else if (name === 'workshop-right') {
      image.rect(x, y + 11, 59, 47, colors.ink);
      image.rect(x, y + 15, 55, 39, colors.wood);
      for (let plank = 19; plank < 54; plank += 10)
        image.rect(x, y + plank, 55, 2, colors.woodLight);
      image.rect(x + 9, y + 20, 27, 34, colors.ink);
      image.rect(x + 13, y + 24, 19, 30, colors.shadow);
      image.rect(x + 18, y + 37, 4, 4, colors.sunflower);
      image.rect(x + 40, y + 23, 11, 20, colors.cream);
    } else if (name === 'workshop-yard') {
      image.rect(x + 5, y + 45, 54, 10, colors.ink);
      image.rect(x + 8, y + 48, 48, 5, colors.wood);
      image.rect(x + 12, y + 22, 8, 25, colors.shadow);
      image.rect(x + 18, y + 18, 27, 7, colors.ink);
      image.rect(x + 22, y + 20, 19, 3, colors.sunflower);
      image.rect(x + 39, y + 25, 6, 22, colors.coral);
      image.rect(x + 46, y + 35, 9, 12, colors.cream);
    } else if (name === 'gate-roof-left') {
      roof(
        image,
        x + 3,
        y + 12,
        61,
        24,
        'left',
        colors.coral,
        colors.ink,
        colors.woodLight,
      );
      image.rect(x + 4, y + 36, 60, 6, colors.ink);
      image.rect(x + 11, y + 42, 8, 14, colors.wood);
    } else if (name === 'gate-roof-right') {
      roof(
        image,
        x,
        y + 12,
        61,
        24,
        'right',
        colors.coral,
        colors.ink,
        colors.woodLight,
      );
      image.rect(x, y + 36, 60, 6, colors.ink);
      image.rect(x + 45, y + 42, 8, 14, colors.wood);
      image.rect(x + 23, y + 19, 12, 8, colors.sunflower);
    } else if (name === 'bridge-rail') {
      image.rect(x, y + 37, 64, 5, colors.ink);
      image.rect(x, y + 33, 64, 4, colors.woodLight);
      image.rect(x, y + 27, 64, 5, colors.ink);
      image.rect(x, y + 29, 64, 3, colors.wood);
      for (let post = 3; post < 64; post += 18) {
        image.rect(x + post, y + 20, 7, 27, colors.ink);
        image.rect(x + post + 2, y + 23, 3, 21, colors.wood);
      }
    } else if (name === 'tree-green') {
      tree(
        image,
        x,
        y,
        colors.moss,
        colors.mossLight,
        colors.wood,
        colors.ink,
        [],
      );
    } else if (name === 'tree-blossom') {
      tree(
        image,
        x,
        y,
        colors.mossLight,
        colors.cream,
        colors.wood,
        colors.ink,
        [
          { offsetX: 18, offsetY: 22, color: colors.coral },
          { offsetX: 31, offsetY: 16, color: colors.white },
          { offsetX: 40, offsetY: 29, color: colors.coral },
        ],
      );
    } else if (name === 'tree-canopy-foreground') {
      image.rect(x + 3, y + 26, 58, 27, colors.ink);
      image.rect(x + 8, y + 20, 48, 35, colors.ink);
      image.rect(x + 13, y + 15, 38, 40, colors.moss);
      image.rect(x + 6, y + 31, 52, 18, colors.moss);
      image.rect(x + 16, y + 20, 14, 8, colors.mossLight);
      image.rect(x + 39, y + 28, 11, 7, colors.mossLight);
      image.rect(x + 20, y + 47, 30, 5, colors.shadow);
    } else if (name === 'hedge-horizontal') {
      image.rect(x, y + 23, 64, 25, colors.ink);
      image.rect(x, y + 27, 64, 17, colors.moss);
      checker(image, x, y + 29, 64, 11, colors.moss, colors.mossLight, 8);
    } else if (name === 'hedge-vertical') {
      image.rect(x + 20, y, 25, 64, colors.ink);
      image.rect(x + 24, y, 17, 64, colors.moss);
      checker(image, x + 27, y, 11, 64, colors.moss, colors.mossLight, 8);
    } else if (name === 'fence-horizontal') {
      image.rect(x, y + 28, 64, 7, colors.ink);
      image.rect(x, y + 30, 64, 3, colors.cream);
      image.rect(x, y + 43, 64, 7, colors.ink);
      image.rect(x, y + 45, 64, 3, colors.cream);
      for (let post = 3; post + 8 <= 64; post += 20) {
        image.rect(x + post, y + 20, 8, 36, colors.ink);
        image.rect(x + post + 2, y + 23, 4, 30, colors.woodLight);
      }
    } else if (name === 'fence-vertical') {
      image.rect(x + 20, y, 7, 64, colors.ink);
      image.rect(x + 22, y, 3, 64, colors.cream);
      image.rect(x + 38, y, 7, 64, colors.ink);
      image.rect(x + 40, y, 3, 64, colors.cream);
      for (let post = 3; post + 8 <= 64; post += 20) {
        image.rect(x + 16, y + post, 34, 8, colors.ink);
        image.rect(x + 19, y + post + 2, 28, 4, colors.woodLight);
      }
    } else if (name === 'lamp-post') {
      image.rect(x + 27, y + 25, 10, 32, colors.ink);
      image.rect(x + 30, y + 27, 4, 27, colors.wood);
      image.rect(x + 18, y + 9, 28, 22, colors.ink);
      image.rect(x + 22, y + 13, 20, 14, colors.sunflower);
      image.rect(x + 25, y + 15, 14, 10, colors.white);
      image.rect(x + 21, y + 5, 22, 7, colors.coral);
      image.rect(x + 20, y + 54, 24, 5, colors.ink);
    } else if (name === 'bench-detailed') {
      image.rect(x + 7, y + 25, 50, 8, colors.ink);
      image.rect(x + 10, y + 27, 44, 4, colors.woodLight);
      image.rect(x + 5, y + 37, 54, 10, colors.ink);
      image.rect(x + 9, y + 40, 46, 4, colors.wood);
      image.rect(x + 11, y + 47, 7, 11, colors.ink);
      image.rect(x + 46, y + 47, 7, 11, colors.ink);
      image.rect(x + 13, y + 49, 3, 7, colors.shadow);
      image.rect(x + 48, y + 49, 3, 7, colors.shadow);
    } else if (name === 'flower-bed') {
      image.rect(x + 4, y + 39, 56, 18, colors.ink);
      image.rect(x + 8, y + 43, 48, 10, colors.wood);
      for (let flower = 10; flower < 56; flower += 9) {
        image.rect(x + flower + 1, y + 27, 2, 14, colors.moss);
        image.rect(
          x + flower - 1,
          y + 24 + (flower % 3),
          6,
          6,
          flower % 2 === 0 ? colors.coral : colors.sunflower,
        );
        image.rect(x + flower + 1, y + 26 + (flower % 3), 2, 2, colors.white);
      }
    } else if (name === 'planter') {
      image.rect(x + 13, y + 32, 38, 23, colors.ink);
      image.rect(x + 17, y + 36, 30, 15, colors.coral);
      image.rect(x + 10, y + 29, 44, 8, colors.ink);
      image.rect(x + 14, y + 31, 36, 3, colors.cream);
      image.rect(x + 29, y + 13, 6, 17, colors.moss);
      image.rect(x + 20, y + 16, 14, 9, colors.mossLight);
      image.rect(x + 34, y + 10, 13, 11, colors.moss);
    } else if (name === 'market-crates-detailed') {
      image.rect(x + 5, y + 35, 32, 23, colors.ink);
      image.rect(x + 9, y + 39, 24, 15, colors.wood);
      image.rect(x + 27, y + 27, 32, 31, colors.ink);
      image.rect(x + 31, y + 31, 24, 23, colors.woodLight);
      image.rect(x + 13, y + 43, 16, 3, colors.cream);
      image.rect(x + 35, y + 36, 16, 3, colors.shadow);
      image.rect(x + 35, y + 43, 6, 6, colors.coral);
      image.rect(x + 45, y + 42, 6, 7, colors.sunflower);
    } else if (name === 'dock') {
      image.rect(x, y + 23, 64, 32, colors.ink);
      image.rect(x, y + 27, 64, 24, colors.wood);
      for (let plank = 2; plank + 3 <= 64; plank += 12)
        image.rect(x + plank, y + 27, 3, 24, colors.woodLight);
      image.rect(x, y + 37, 64, 3, colors.shadow);
      image.rect(x + 7, y + 17, 8, 39, colors.ink);
      image.rect(x + 49, y + 17, 8, 39, colors.ink);
    } else if (name === 'plaza-fountain-detailed') {
      image.rect(x + 6, y + 43, 52, 13, colors.ink);
      image.rect(x + 10, y + 40, 44, 12, colors.cream);
      image.rect(x + 16, y + 31, 32, 12, colors.ink);
      image.rect(x + 20, y + 29, 24, 10, colors.sky);
      image.rect(x + 28, y + 13, 8, 18, colors.ink);
      image.rect(x + 30, y + 10, 4, 19, colors.skyLight);
      image.rect(x + 22, y + 17, 5, 12, colors.sky);
      image.rect(x + 37, y + 19, 5, 11, colors.sky);
      image.rect(x + 25, y + 8, 14, 5, colors.white);
    } else if (name === 'plaza-banner') {
      image.rect(x + 11, y + 7, 7, 51, colors.ink);
      image.rect(x + 14, y + 9, 3, 46, colors.wood);
      image.rect(x + 17, y + 11, 36, 35, colors.ink);
      image.rect(x + 20, y + 14, 30, 28, colors.coral);
      image.rect(x + 26, y + 19, 18, 14, colors.sunflower);
      image.rect(x + 31, y + 23, 8, 7, colors.white);
      image.rect(x + 20, y + 42, 8, 7, colors.ink);
      image.rect(x + 42, y + 42, 8, 7, colors.ink);
    } else if (name === 'shoreline-reeds') {
      image.rect(x, y + 52, 64, 7, colors.sky);
      image.rect(x, y + 57, 64, 3, colors.skyLight);
      for (let reed = 5; reed + 4 <= 63; reed += 8) {
        const height = 18 + (reed % 4) * 3;
        image.rect(x + reed, y + 52 - height, 3, height, colors.moss);
        image.rect(x + reed - 3, y + 40 - (reed % 5), 6, 3, colors.mossLight);
        image.rect(x + reed + 1, y + 29 + (reed % 7), 3, 7, colors.wood);
      }
    } else {
      image.rect(x + 7, y + 16, 50, 42, colors.ink);
      image.rect(
        x + 10,
        y + 19,
        44,
        36,
        index % 3 === 0
          ? colors.moss
          : index % 3 === 1
            ? colors.wood
            : colors.coral,
      );
      image.rect(x + 20, y + 7, 24, 14, colors.sunflower);
    }
    image.endWriteBoundary();
  });
  return { image, names };
}

mkdirSync(roomDirectory, { recursive: true });
mkdirSync(catDirectory, { recursive: true });
mkdirSync(townDirectory, { recursive: true });
mkdirSync(petsDirectory, { recursive: true });
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
        frames: {
          bed: 0,
          sofa: 1,
          rug: 7,
          window: 2,
          'food-bowl': 3,
          bookshelf: 4,
          'toy-basket': 5,
          arcade: 6,
        },
      },
    },
    null,
    2,
  )}\n`,
);

const animations = Object.fromEntries(
  ['idle', 'walk', 'sit', 'sleep', 'happy', 'curious', 'confused'].map(
    (state, row) => [
      state,
      {
        frames: [0, 1, 2, 3].map((column) => row * 4 + column),
        frameRate: state === 'walk' ? 9 : 5,
      },
    ],
  ),
);
const petManifest = {
  schemaVersion: 'pet-sprite.v1',
  pixelArt: true,
  image: 'pet-atlas.png',
  frame: { width: 32, height: 32 },
  columns: 4,
  rows: 7,
  anchor: { x: 0.5, y: 0.78 },
  body: { width: 24, height: 24, offsetX: 4, offsetY: 6 },
  animations,
};
const pets = [
  {
    spriteId: 'player-cat',
    primary: '#E9953D',
    secondary: '#FFF0C9',
    accent: '#5A4636',
    ears: 'round',
    tail: 'long',
    marking: 'stripe',
  },
  {
    spriteId: 'orange-cat',
    primary: '#F29A38',
    secondary: '#FFF3D6',
    accent: '#327A78',
    ears: 'tall',
    tail: 'long',
    marking: 'stripe',
  },
  {
    spriteId: 'gray-cat',
    primary: '#89939E',
    secondary: '#E8ECEF',
    accent: '#58705A',
    ears: 'round',
    tail: 'bushy',
    marking: 'mask',
  },
  {
    spriteId: 'blue-cat',
    primary: '#5E91C9',
    secondary: '#DCEBFA',
    accent: '#F0B84C',
    ears: 'tall',
    tail: 'short',
    marking: 'spot',
  },
  {
    spriteId: 'cream-cat',
    primary: '#E8C98F',
    secondary: '#FFF7E8',
    accent: '#4E7187',
    ears: 'round',
    tail: 'bushy',
    marking: 'spot',
  },
];
pets.forEach((pet) => {
  const directory = join(petsDirectory, pet.spriteId);
  mkdirSync(directory, { recursive: true });
  writePng(join(directory, 'pet-atlas.png'), drawPetAtlas(pet));
  writeFileSync(
    join(directory, 'manifest.json'),
    `${JSON.stringify(petManifest, null, 2)}\n`,
  );
});

const townAtlas = drawTownAtlas();
writePng(join(townDirectory, 'town-background.png'), drawTownBackground());
writePng(join(townDirectory, 'town-atlas.png'), townAtlas.image);
writeFileSync(
  join(townDirectory, 'manifest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 'town-assets.v1',
      pixelArt: true,
      background: { image: 'town-background.png', width: 640, height: 360 },
      atlas: {
        image: 'town-atlas.png',
        frame: { width: 64, height: 64 },
        columns: 8,
        rows: 8,
        frames: Object.fromEntries(
          townAtlas.names.map((name, index) => [name, index]),
        ),
      },
    },
    null,
    2,
  )}\n`,
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

console.log(
  'Generated room assets, town 640x360 + atlas, and five 128x224 pet atlases.',
);
