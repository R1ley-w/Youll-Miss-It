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

describe('suspending', () => {
  it('drops the hold and ignores presses until resumed', () => {
    const g = new TouchGestures();
    g.press(1, 'left', 300, 0);
    g.suspend();
    expect(g.steering()).toBeNull();

    g.press(2, 'right', 300, 100);
    expect(g.steering()).toBeNull();

    g.resume();
    g.press(3, 'right', 300, 200);
    expect(g.steering()).toBe('right');
  });
});
