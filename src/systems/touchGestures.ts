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
export const FLICK_REARM = 20; // how far back down before the same finger can flick again

interface Finger {
  side: Side;
  /** Recent positions, oldest first: one from before the flick window, the rest inside it. */
  trail: { y: number; t: number }[];
  /** False from a flick until the finger comes back down, so one long drag is one jump. */
  armed: boolean;
  /** Highest point reached since the flick; coming back down is measured from here. */
  peakY: number;
}

/*
  Every finger is tracked on its own, so a jump never costs the hold:
  - The first finger down steers, by the half it landed on. Sliding across the middle does
    not reverse it.
  - Any finger can flick up to jump, including the steering one, without lifting.
  - Later fingers only jump. If the steering finger lifts, the next-oldest takes over.
*/
export class TouchGestures {
  // Insertion order is press order, which is what decides who steers.
  private fingers = new Map<number, Finger>();
  private jumpRequested = false;
  private suspended = false;

  get isSuspended(): boolean {
    return this.suspended;
  }

  press(id: number, side: Side, y: number, t: number) {
    if (this.suspended) return;
    this.fingers.set(id, { side, trail: [{ y, t }], armed: true, peakY: y });
  }

  move(id: number, y: number, t: number) {
    const finger = this.fingers.get(id);
    if (!finger) return;

    if (!finger.armed) {
      finger.peakY = Math.min(finger.peakY, y);
      if (y - finger.peakY < FLICK_REARM) return;
      // Start measuring afresh, or the travel that earned the last jump would count twice.
      finger.armed = true;
      finger.trail = [{ y, t }];
      return;
    }

    const { trail } = finger;
    trail.push({ y, t });
    // Keep one sample from before the window, to work out where the finger was when the
    // window opened. A finger that sat still for seconds and then flicked has no other
    // record of where it started.
    const windowStart = t - FLICK_WINDOW_MS;
    while (trail.length > 2 && trail[1].t <= windowStart) trail.shift();

    const [before, after] = trail;
    const startY =
      before.t < windowStart
        ? before.y + ((after.y - before.y) * (windowStart - before.t)) / (after.t - before.t)
        : before.y;
    const lowest = Math.max(startY, ...trail.slice(1).map((s) => s.y));
    if (lowest - y >= FLICK_DISTANCE) {
      this.jumpRequested = true;
      finger.armed = false;
      finger.peakY = y;
    }
  }

  release(id: number, y: number, t: number) {
    // The lift is the finger's last position: a flick that ends by lifting still counts.
    this.move(id, y, t);
    this.fingers.delete(id);
  }

  /** The fingers left the play area: nothing is held any more. */
  releaseAll() {
    this.fingers.clear();
  }

  /** Drop every hold and ignore presses until resume(). */
  suspend() {
    this.suspended = true;
    this.fingers.clear();
    this.jumpRequested = false;
  }

  resume() {
    this.suspended = false;
  }

  steering(): Side | null {
    for (const finger of this.fingers.values()) return finger.side;
    return null;
  }

  /** True once per flick: reading it clears it. */
  takeJump(): boolean {
    const jump = this.jumpRequested;
    this.jumpRequested = false;
    return jump;
  }
}
