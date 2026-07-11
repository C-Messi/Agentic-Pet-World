import Phaser from 'phaser';

import { WorldScene } from './scenes/world-scene';

export const GAME_WIDTH = 768;
export const GAME_HEIGHT = 512;

export function createGame(parent: string | HTMLElement): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#3a3029',
    pixelArt: true,
    antialias: false,
    roundPixels: true,
    render: {
      antialias: false,
      pixelArt: true,
      preserveDrawingBuffer: import.meta.env.DEV,
      roundPixels: true,
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
      min: { width: 360, height: 240 },
    },
    scene: [WorldScene],
  });
}
