import { describe, expect, it } from 'vitest';

import catManifest from '../../../public/assets/cat/manifest.json';
import roomManifest from '../../../public/assets/room/manifest.json';

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
    expect(Object.values(catManifest.animations).every(({ frames }) => frames.length === 4)).toBe(
      true,
    );
  });

  it('defines a fixed room and furniture frame for each registered object', () => {
    expect(roomManifest.room).toEqual({ image: 'room-background.png', width: 384, height: 256 });
    expect(roomManifest.furniture.frame).toEqual({ width: 64, height: 64 });
    expect(Object.keys(roomManifest.furniture.frames)).toEqual([
      'bed',
      'sofa',
      'window',
      'food-bowl',
      'bookshelf',
      'toy-basket',
      'arcade',
    ]);
  });
});
