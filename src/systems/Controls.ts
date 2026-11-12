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
 * Offered every press before it can steer Greg. To take it (a press on a chest), return
 * what the tap should do; the press then never becomes a hold.
 *
 * The action runs when the finger lifts, inside the browser's own handler for that event.
 * That timing is the point: browsers only let a page open a window from an event they count
 * as a user gesture, and by the HTML spec a finger lifting (touchend) is one where a finger
 * landing (touchstart) is not. Opening on the press left chests dead on a phone.
 */
export type PressHandler = (worldX: number, worldY: number) => (() => void) | null;

/*
  Keyboard and touch behind one question. Desktop: A/D or arrows to move, W/up/space to jump.
  Touch: hold a half of the map to move, flick up to jump, with the same finger or another
  one (the rules are in touchGestures.ts). The scene asks read() once per frame and never
  looks at a key or a pointer itself.
*/
export class Controls {
  private gestures = new TouchGestures();
  private tapActions = new Map<number, () => void>();
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
      const onTap = takesPress(pointer.worldX, pointer.worldY);
      if (onTap) {
        this.tapActions.set(pointer.id, onTap);
        this.gestures.claim(pointer.id, pointer.worldX, pointer.worldY);
        return;
      }
      this.gestures.press(pointer.id, pointer.worldX < midline ? 'left' : 'right', pointer.y, now());
    });

    scene.input.on('pointermove', (pointer: Phaser.Input.Pointer) =>
      this.gestures.move(pointer.id, pointer.y, now())
    );

    const release = (pointer: Phaser.Input.Pointer) => {
      const onTap = this.tapActions.get(pointer.id);
      this.tapActions.delete(pointer.id);
      const result = this.gestures.release(pointer.id, pointer.worldX, pointer.worldY, now());
      if (result === 'tap') onTap?.();
    };
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
