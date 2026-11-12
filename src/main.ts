import Phaser from 'phaser';
import { DungeonScene } from './scenes/DungeonScene';
import { Layout, pickLayout } from './layouts';
import { audio } from './systems/audio';

// The audio engine lives outside the game, so it is wired up once here rather than per scene.
audio.init();
if (import.meta.env.DEV) {
  (window as unknown as { audio: typeof audio }).audio = audio;
}

/*
  Add ?debug to the address for a live readout of the audio engine on screen. A phone has no
  console to look at, and the audio failures worth chasing only happen on a phone.
*/
if (new URLSearchParams(location.search).has('debug')) {
  const readout = document.createElement('pre');
  readout.style.cssText =
    'position:fixed;left:4px;bottom:64px;z-index:40;margin:0;padding:4px 6px;max-width:70vw;' +
    'font:10px/1.3 monospace;color:#9f9;background:rgba(0,0,0,.8);pointer-events:none;' +
    'white-space:pre-wrap';
  document.body.appendChild(readout);
  window.setInterval(() => {
    const d = audio.debug();
    const t = d.wantedTrack;
    const r = d.lastPlayRejection;
    readout.textContent = [
      `ctx ${d.ctxState}  unlocked ${d.unlocked}  muted ${d.muted}`,
      `master ${d.masterGain?.toFixed(2)}  bed ${d.bedGain?.toFixed(2)}`,
      `chest ${d.activeChest}  reward ${d.rewardActive}`,
      t
        ? `song ${d.wantedSong}: ${t.paused ? 'PAUSED' : 'playing'} t=${t.time} gain=${t.gain} ` +
          `ready=${t.readyState} mem=${t.fromMemory} blessed=${t.blessed} err=${t.error}`
        : `song ${d.wantedSong}: no element`,
      `preloaded ${d.songsPreloaded.length}  blessed ${d.songsBlessed.length}/${d.songsLoaded.length}`,
      r ? `last refused: ${r.song} ${r.reason} ${r.secondsAgo}s ago` : 'last refused: none',
    ].join('\n');
  }, 250);
}

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
    // Phaser tracks one touch by default. A second lets one thumb hold a direction while
    // the other flicks to jump.
    input: { activePointers: 2 },
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
