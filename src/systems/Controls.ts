import Phaser from 'phaser';
import { TouchGestures } from './touchGestures';

/** What the visitor is asking Greg to do this frame, whichever input it came from. */
export interface Intent {
  left: boolean;
  right: boolean;
  /** True for one frame per key press or flick. */
  jump: boolean;
}

/**
 * Offered every press before it can steer Greg. Return true to take it (a tap on a chest):
 * it then never becomes a hold. It runs inside the browser's own event handler, so it may
 * open a window without tripping the popup blocker.
 */
export type PressHandler = (worldX: number, worldY: number) => boolean;

/*
  Keyboard and touch behind one question. Desktop: A/D or arrows to move, W/up/space to jump.
  Touch: hold a half of the map to move, flick up to jump. The scene asks read() once per
  frame and never looks at a key or a pointer itself.
*/
export class Controls {
  private gestures = new TouchGestures();
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys: Record<'W' | 'A' | 'D' | 'SPACE', Phaser.Input.Keyboard.Key>;

  constructor(scene: Phaser.Scene, takesPress: PressHandler) {
    const keyboard = scene.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.keys = keyboard.addKeys('W,A,D,SPACE') as typeof this.keys;

    const now = () => scene.time.now;
    const midline = scene.scale.width / 2;

    scene.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.gestures.isSuspended) return;
      if (takesPress(pointer.worldX, pointer.worldY)) return;
      this.gestures.press(pointer.id, pointer.worldX < midline ? 'left' : 'right', pointer.y, now());
    });

    const release = (pointer: Phaser.Input.Pointer) =>
      this.gestures.release(pointer.id, pointer.y, now());
    scene.input.on('pointerup', release);
    scene.input.on('pointerupoutside', release);

    scene.input.on('gameout', () => this.gestures.releaseAll());
  }

  /** Call once per frame: jump is consumed by reading it. */
  read(): Intent {
    const steering = this.gestures.steering();
    const { JustDown } = Phaser.Input.Keyboard;
    // Each JustDown is evaluated (no short-circuit) so one key can't leave another's press
    // waiting to fire a second jump on a later frame.
    const keyJump = [this.cursors.up, this.keys.W, this.keys.SPACE].map((k) => JustDown(k));
    const flickJump = this.gestures.takeJump();

    return {
      left: this.cursors.left.isDown || this.keys.A.isDown || steering === 'left',
      right: this.cursors.right.isDown || this.keys.D.isDown || steering === 'right',
      jump: flickJump || keyJump.some(Boolean),
    };
  }

  /** Greg can't be steered for a while: drop every hold and ignore presses until resume(). */
  suspend() {
    this.gestures.suspend();
  }

  resume() {
    this.gestures.resume();
  }
}
