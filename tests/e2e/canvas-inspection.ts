import type { Page } from '@playwright/test';

export interface PixelBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CanvasInspection {
  width: number;
  height: number;
  dataUrlLength: number;
  opaquePixels: number;
  variedPixels: number;
  darkPixels: number;
  lightPixels: number;
  bubbleFillPixels: number;
  bubbleTextPixels: number;
  darkRatio: number;
  goldPixels: number;
  hash: number;
  bubble: (PixelBounds & { pixels: number; textPixels: number }) | null;
  cat:
    | (PixelBounds & { centroidX: number; centroidY: number; pixels: number })
    | null;
  furniture: {
    wall: PixelBounds & { pixels: number };
    rug: PixelBounds & { pixels: number };
    window: PixelBounds & { pixels: number };
    coral: PixelBounds & { pixels: number };
  };
}

export interface TownCanvasInspection {
  width: number;
  height: number;
  opaqueRatio: number;
  variedRatio: number;
  distinctColorBuckets: number;
  variedBounds: PixelBounds | null;
  hash: number;
}

export async function inspectTownCanvas(
  page: Page,
): Promise<TownCanvasInspection> {
  return page
    .locator('.game-surface canvas')
    .evaluate(async (canvas: HTMLCanvasElement) => {
      const image = new Image();
      image.src = canvas.toDataURL('image/png');
      await image.decode();
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Town canvas inspection is unavailable');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      const total = canvas.width * canvas.height;
      const first = [pixels[0] ?? 0, pixels[1] ?? 0, pixels[2] ?? 0];
      const buckets = new Set<number>();
      let opaque = 0;
      let varied = 0;
      let variedMinX = canvas.width;
      let variedMinY = canvas.height;
      let variedMaxX = -1;
      let variedMaxY = -1;
      let hash = 2_166_136_261;
      for (let pixel = 0, offset = 0; pixel < total; pixel += 1, offset += 4) {
        const r = pixels[offset] ?? 0;
        const g = pixels[offset + 1] ?? 0;
        const b = pixels[offset + 2] ?? 0;
        if ((pixels[offset + 3] ?? 0) > 0) opaque += 1;
        if (r !== first[0] || g !== first[1] || b !== first[2]) {
          const x = pixel % canvas.width;
          const y = Math.floor(pixel / canvas.width);
          varied += 1;
          variedMinX = Math.min(variedMinX, x);
          variedMinY = Math.min(variedMinY, y);
          variedMaxX = Math.max(variedMaxX, x);
          variedMaxY = Math.max(variedMaxY, y);
        }
        if (pixel % 31 === 0)
          buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
        if (pixel % 97 === 0) {
          hash ^= (r << 16) | (g << 8) | b;
          hash = Math.imul(hash, 16_777_619) >>> 0;
        }
      }
      return {
        width: canvas.width,
        height: canvas.height,
        opaqueRatio: opaque / total,
        variedRatio: varied / total,
        distinctColorBuckets: buckets.size,
        variedBounds:
          varied === 0
            ? null
            : {
                minX: variedMinX,
                minY: variedMinY,
                maxX: variedMaxX,
                maxY: variedMaxY,
              },
        hash,
      };
    });
}

export async function inspectCanvas(page: Page): Promise<CanvasInspection> {
  return page
    .locator('.game-surface canvas')
    .evaluate(async (canvas: HTMLCanvasElement) => {
      const dataUrl = canvas.toDataURL('image/png');
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('2D canvas inspection is unavailable');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      const total = copy.width * copy.height;
      const masks = {
        cat: new Uint8Array(total),
        wall: new Uint8Array(total),
        rug: new Uint8Array(total),
        window: new Uint8Array(total),
        coral: new Uint8Array(total),
        bubble: new Uint8Array(total),
      };
      let opaquePixels = 0;
      let variedPixels = 0;
      let darkPixels = 0;
      let lightPixels = 0;
      let bubbleFillPixels = 0;
      let bubbleTextPixels = 0;
      let goldPixels = 0;
      let hash = 2_166_136_261;
      const first = [pixels[0] ?? 0, pixels[1] ?? 0, pixels[2] ?? 0];

      for (let pixel = 0, offset = 0; pixel < total; pixel += 1, offset += 4) {
        const r = pixels[offset] ?? 0;
        const g = pixels[offset + 1] ?? 0;
        const b = pixels[offset + 2] ?? 0;
        const a = pixels[offset + 3] ?? 0;
        if (a > 0) opaquePixels += 1;
        if (r !== first[0] || g !== first[1] || b !== first[2])
          variedPixels += 1;
        if (r < 55 && g < 50 && b < 55) darkPixels += 1;
        if (r > 225 && g > 220 && b > 200) lightPixels += 1;
        const isBubbleFill =
          (r > 245 && g > 235 && b >= 195 && b <= 225) ||
          (r >= 210 &&
            r <= 230 &&
            g >= 225 &&
            g <= 240 &&
            b >= 210 &&
            b <= 235);
        if (isBubbleFill) {
          bubbleFillPixels += 1;
          masks.bubble[pixel] = 1;
        }
        if (r >= 40 && r <= 50 && g >= 32 && g <= 42 && b >= 35 && b <= 45)
          bubbleTextPixels += 1;
        if (r > 220 && g > 165 && g < 235 && b < 125) goldPixels += 1;
        if (r > 195 && g >= 65 && g <= 150 && b < 90) masks.cat[pixel] = 1;
        if (r >= 140 && r <= 205 && g >= 75 && g <= 140 && b >= 45 && b <= 100)
          masks.wall[pixel] = 1;
        if (r >= 75 && r <= 155 && g >= 95 && g <= 170 && b >= 45 && b <= 125)
          masks.rug[pixel] = 1;
        if (
          r >= 120 &&
          r <= 205 &&
          g >= 175 &&
          g <= 235 &&
          b >= 180 &&
          b <= 245
        )
          masks.window[pixel] = 1;
        if (r >= 175 && r <= 235 && g >= 70 && g <= 145 && b >= 70 && b <= 145)
          masks.coral[pixel] = 1;
        if (pixel % 97 === 0) {
          hash ^= (r << 16) | (g << 8) | b;
          hash = Math.imul(hash, 16_777_619) >>> 0;
        }
      }

      const boundsFor = (mask: Uint8Array) => {
        let pixels = 0;
        let minX = copy.width;
        let minY = copy.height;
        let maxX = -1;
        let maxY = -1;
        for (let index = 0; index < mask.length; index += 1) {
          if (mask[index] !== 1) continue;
          const x = index % copy.width;
          const y = Math.floor(index / copy.width);
          pixels += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        return { pixels, minX, minY, maxX, maxY };
      };

      const visited = new Uint8Array(total);
      const components: Array<
        PixelBounds & { pixels: number; centroidX: number; centroidY: number }
      > = [];
      for (let start = 0; start < total; start += 1) {
        if (masks.cat[start] !== 1 || visited[start] === 1) continue;
        const queue = [start];
        visited[start] = 1;
        let cursor = 0;
        let count = 0;
        let sumX = 0;
        let sumY = 0;
        let minX = copy.width;
        let minY = copy.height;
        let maxX = -1;
        let maxY = -1;
        while (cursor < queue.length) {
          const index = queue[cursor++]!;
          const x = index % copy.width;
          const y = Math.floor(index / copy.width);
          count += 1;
          sumX += x;
          sumY += y;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          for (const next of [
            index - 1,
            index + 1,
            index - copy.width,
            index + copy.width,
          ]) {
            if (
              next < 0 ||
              next >= total ||
              visited[next] === 1 ||
              masks.cat[next] !== 1
            )
              continue;
            const nextX = next % copy.width;
            if (Math.abs(nextX - x) > 1) continue;
            visited[next] = 1;
            queue.push(next);
          }
        }
        if (count >= 12 && count <= 2_000) {
          components.push({
            pixels: count,
            minX,
            minY,
            maxX,
            maxY,
            centroidX: sumX / count,
            centroidY: sumY / count,
          });
        }
      }
      components.sort((left, right) => right.pixels - left.pixels);

      const bubbleVisited = new Uint8Array(total);
      const bubbleComponents: Array<
        PixelBounds & { pixels: number; textPixels: number }
      > = [];
      for (let start = 0; start < total; start += 1) {
        if (masks.bubble[start] !== 1 || bubbleVisited[start] === 1) continue;
        const queue = [start];
        bubbleVisited[start] = 1;
        let cursor = 0;
        let count = 0;
        let minX = copy.width;
        let minY = copy.height;
        let maxX = -1;
        let maxY = -1;
        while (cursor < queue.length) {
          const index = queue[cursor++]!;
          const x = index % copy.width;
          const y = Math.floor(index / copy.width);
          count += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          for (const next of [
            index - 1,
            index + 1,
            index - copy.width,
            index + copy.width,
          ]) {
            if (
              next < 0 ||
              next >= total ||
              bubbleVisited[next] === 1 ||
              masks.bubble[next] !== 1
            )
              continue;
            const nextX = next % copy.width;
            if (Math.abs(nextX - x) > 1) continue;
            bubbleVisited[next] = 1;
            queue.push(next);
          }
        }
        const width = maxX - minX + 1;
        const height = maxY - minY + 1;
        if (
          count < 200 ||
          width < 80 ||
          width > 260 ||
          height < 25 ||
          height > 130
        )
          continue;
        let textPixels = 0;
        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            const offset = (y * copy.width + x) * 4;
            if (
              (pixels[offset] ?? 255) < 105 &&
              (pixels[offset + 1] ?? 255) < 105 &&
              (pixels[offset + 2] ?? 255) < 105
            ) {
              textPixels += 1;
            }
          }
        }
        bubbleComponents.push({
          pixels: count,
          minX,
          minY,
          maxX,
          maxY,
          textPixels,
        });
      }
      bubbleComponents.sort((left, right) => right.pixels - left.pixels);

      return {
        width: copy.width,
        height: copy.height,
        dataUrlLength: dataUrl.length,
        opaquePixels,
        variedPixels,
        darkPixels,
        lightPixels,
        bubbleFillPixels,
        bubbleTextPixels,
        darkRatio: darkPixels / total,
        goldPixels,
        hash,
        bubble: bubbleComponents[0] ?? null,
        cat: components[0] ?? null,
        furniture: {
          wall: boundsFor(masks.wall),
          rug: boundsFor(masks.rug),
          window: boundsFor(masks.window),
          coral: boundsFor(masks.coral),
        },
      };
    });
}

export function hasRenderedRoom(inspection: CanvasInspection): boolean {
  return (
    inspection.dataUrlLength > 10_000 &&
    inspection.opaquePixels > inspection.width * inspection.height * 0.95 &&
    inspection.variedPixels > inspection.width * inspection.height * 0.5 &&
    inspection.cat !== null &&
    inspection.furniture.wall.pixels > 20_000 &&
    inspection.furniture.rug.pixels > 8_000 &&
    inspection.furniture.window.pixels > 2_000 &&
    inspection.furniture.coral.pixels > 2_000
  );
}
