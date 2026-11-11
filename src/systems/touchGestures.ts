/*
  The touch rules, with no Phaser in sight: finger events in, steering and jump out. Controls
  feeds this from Phaser's pointers; the tests feed it by hand. Positions are map pixels, as
  Phaser reports them, and times are milliseconds on any one clock.
*/

/** Which half of the map a finger landed on. */
export type Side = 'left' | 'right';

// Ear-and-thumb values: tune on a real phone rather than deriving them.
export const FLICK_DISTANCE = 40; // how far up a finger must travel to count as a flick
export const FLICK_WINDOW_MS = 400; // ...and how quickly

export class TouchGestures {
  private hold: { id: number; side: Side; y: number; t: number } | null = null;
  private jumpRequested = false;
  private suspended = false;

  get isSuspended(): boolean {
    return this.suspended;
  }

  press(id: number, side: Side, y: number, t: number) {
    if (this.suspended) return;
    this.hold = { id, side, y, t };
  }

  release(id: number, y: number, t: number) {
    const hold = this.hold;
    if (!hold || hold.id !== id) return;
    if (y - hold.y < -FLICK_DISTANCE && t - hold.t < FLICK_WINDOW_MS) this.jumpRequested = true;
    this.hold = null;
  }

  /** The finger left the play area: nothing is held any more. */
  releaseAll() {
    this.hold = null;
  }

  /** Drop every hold and ignore presses until resume(). */
  suspend() {
    this.suspended = true;
    this.hold = null;
    this.jumpRequested = false;
  }

  resume() {
    this.suspended = false;
  }

  steering(): Side | null {
    return this.hold?.side ?? null;
  }

  /** True once per flick: reading it clears it. */
  takeJump(): boolean {
    const jump = this.jumpRequested;
    this.jumpRequested = false;
    return jump;
  }
}
