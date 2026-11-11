import { describe, expect, it } from 'vitest';
import { TouchGestures } from './touchGestures';

describe('holding', () => {
  it('steers toward the half the finger landed on', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    expect(g.steering()).toBe('left');
    g.release(1, 300, 1000);
    expect(g.steering()).toBeNull();

    g.press(1, 'right', 300, 2000);
    expect(g.steering()).toBe('right');
  });

  it('lets go of everything when the finger leaves the play area', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.releaseAll();
    expect(g.steering()).toBeNull();
  });
});

describe('flicking', () => {
  it('jumps on a quick upward flick', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.release(1, 250, 150);
    expect(g.takeJump()).toBe(true);
  });

  it('reports a jump once', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.release(1, 250, 150);
    g.takeJump();
    expect(g.takeJump()).toBe(false);
  });

  it('does not jump on a short or downward movement', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.release(1, 280, 150);
    expect(g.takeJump()).toBe(false);

    g.press(1, 'left', 300, 1000);
    g.release(1, 360, 1150);
    expect(g.takeJump()).toBe(false);
  });

  it('does not jump on a slow upward drag', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.release(1, 240, 900);
    expect(g.takeJump()).toBe(false);
  });
});

describe('jumping while moving', () => {
  it('jumps on a flick without ending the hold', () => {
    const g = new TouchGestures();
    g.press(1, 'right', 300, 0);
    g.move(1, 300, 2000);
    g.move(1, 280, 2050);
    g.move(1, 255, 2100);
    expect(g.takeJump()).toBe(true);
    expect(g.steering()).toBe('right');
  });

  it('measures a flick from where a resting finger sat, however long ago', () => {
    const g = new TouchGestures();
    g.press(1, 'right', 300, 0);
    g.move(1, 258, 5000);
    expect(g.takeJump()).toBe(false); // 42px, but over five seconds
    g.move(1, 215, 5100);
    expect(g.takeJump()).toBe(true);
  });

  it('jumps once for one long upward drag', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 400, 0);
    for (let i = 1; i <= 20; i++) g.move(1, 400 - i * 15, i * 16);
    expect(g.takeJump()).toBe(true);
    for (let i = 21; i <= 25; i++) g.move(1, 400 - i * 15, i * 16);
    expect(g.takeJump()).toBe(false);
  });

  it('can flick again once the finger has come back down', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.move(1, 250, 100);
    expect(g.takeJump()).toBe(true);

    g.move(1, 262, 200); // not far enough back down
    g.move(1, 215, 300);
    expect(g.takeJump()).toBe(false);

    g.move(1, 240, 400); // 25px below the peak: re-armed
    g.move(1, 195, 500);
    expect(g.takeJump()).toBe(true);
  });

  it('lets a second finger jump while the first keeps steering', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.press(2, 'right', 300, 1000);
    expect(g.steering()).toBe('left');

    g.move(2, 250, 1100);
    expect(g.takeJump()).toBe(true);
    expect(g.steering()).toBe('left');

    g.release(2, 240, 1150);
    expect(g.steering()).toBe('left');
  });

  it('hands steering to the remaining finger when the first lifts', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.press(2, 'right', 300, 100);
    g.release(1, 300, 2000);
    expect(g.steering()).toBe('right');
    expect(g.takeJump()).toBe(false);
  });
});

describe('suspending', () => {
  it('drops the hold and ignores presses until resumed', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.suspend();
    expect(g.steering()).toBeNull();

    g.move(1, 200, 50); // the dropped finger is still on the glass
    expect(g.takeJump()).toBe(false);

    g.press(2, 'right', 300, 100);
    expect(g.steering()).toBeNull();

    g.resume();
    g.press(3, 'right', 300, 200);
    expect(g.steering()).toBe('right');
  });
});
