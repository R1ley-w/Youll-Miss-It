import Phaser from 'phaser';
import { DungeonScene } from './scenes/DungeonScene';
import { WORLD_WIDTH, WORLD_HEIGHT, GRAVITY_Y } from './constants';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#1a1410',
  pixelArt: true,
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: GRAVITY_Y },
      debug: false,
    },
  },
  scene: [DungeonScene],
};

const game = new Phaser.Game(config);

// Dev-only handle for inspecting/driving the game from the console. Stripped from prod builds.
if (import.meta.env.DEV) {
  (window as unknown as { game: Phaser.Game }).game = game;
}
