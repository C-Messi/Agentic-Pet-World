import Phaser from 'phaser';

import type { MiniGameLaunchData } from './registry';
import { returnToWorld } from './scene-lifecycle';

export class ComingSoonScene extends Phaser.Scene {
  private returnSceneKey = 'WorldScene';

  create(data: MiniGameLaunchData): void {
    this.returnSceneKey = data.returnSceneKey;
    const { width, height } = this.scale;

    this.add.rectangle(width / 2, height / 2, width, height, 0x17131a, 0.82);
    this.add
      .rectangle(width / 2, height / 2, 472, 230, 0x2b2530, 1)
      .setStrokeStyle(4, 0xffd36a, 1);
    this.add
      .text(width / 2, height / 2 - 70, data.title.toUpperCase(), {
        color: '#ffd36a',
        fontFamily: '"Courier New", monospace',
        fontSize: '30px',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    this.add
      .text(width / 2, height / 2 - 12, 'Games are coming soon.', {
        color: '#fff4d6',
        fontFamily: '"Courier New", monospace',
        fontSize: '20px',
      })
      .setOrigin(0.5);

    const button = this.add
      .rectangle(width / 2, height / 2 + 68, 210, 48, 0x8e665a, 1)
      .setStrokeStyle(3, 0xfff4d6, 1)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(width / 2, height / 2 + 68, 'RETURN TO ROOM', {
        color: '#ffffff',
        fontFamily: '"Courier New", monospace',
        fontSize: '16px',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    button.once('pointerup', this.returnToRoom, this);
    this.input.keyboard?.once('keydown-ESC', this.returnToRoom, this);
    this.input.keyboard?.once('keydown-ENTER', this.returnToRoom, this);
  }

  private returnToRoom(): void {
    returnToWorld(this.scene, this.returnSceneKey, this.sys.settings.key);
  }
}
