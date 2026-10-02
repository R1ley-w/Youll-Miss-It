import Phaser from 'phaser';
import { DungeonScene } from './scenes/DungeonScene';
import { Layout, pickLayout } from './layouts';

function buildGame(layout: Layout): Phaser.Game {
  document.body.classList.toggle('layout-landscape', layout.id === 'landscape');

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-container',
    backgroundColor: '#1a1410',
    pixelArt: true,
    width: layout.width,
    height: layout.height,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: layout.physics.gravityY },
        debug: false,
      },
    },
    scene: [new DungeonScene(layout)],
  });

  // Dev-only handle for inspecting/driving the game from the console. Stripped from prod builds.
  if (import.meta.env.DEV) {
    (window as unknown as { game: Phaser.Game }).game = game;
  }
  return game;
}

let layout = pickLayout();
let game = buildGame(layout);

/*
  Swap maps when the viewport changes shape enough to cross between portrait and landscape
  — rotating a phone, or dragging a desktop window narrow. Rebuilding is cheap because the
  textures are already cached and collected items live in localStorage; the only visible
  cost is Greg respawning on the ground floor.
*/
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const next = pickLayout();
    if (next.id === layout.id) return;
    layout = next;

    // Phaser defers teardown to its next step, so let that land before mounting the
    // replacement — otherwise the outgoing game can tear down the incoming canvas.
    game.destroy(true);
    window.setTimeout(() => {
      game = buildGame(layout);
    }, 100);
  }, 250);
});
