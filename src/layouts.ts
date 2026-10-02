import { ItemId } from './systems/Inventory';

export interface Ledge {
  key: ItemId;
  label: string;
  surfaceY: number;
  x0: number;
  x1: number;
  /** Top-left of the chest's 16px tile; it always sits one tile above surfaceY. */
  chestX: number;
  chestY: number;
}

/** A platform with no destination on it — purely somewhere to stand on the way up. */
export interface SteppingStone {
  surfaceY: number;
  x0: number;
  x1: number;
}

export interface Layout {
  id: 'portrait' | 'landscape';
  backgroundSrc: string;
  width: number;
  height: number;
  groundSurfaceY: number;
  spawnX: number;
  ledges: Ledge[];
  steppingStones: SteppingStone[];
  physics: { moveSpeed: number; jumpVelocity: number; gravityY: number };
}

// Both layouts are read off their background's 16px tile grid. Ledges are listed in climb
// order so the destination ordering stays the same between them — merch lowest, socials
// highest — even though the geometry is completely different.

export const PORTRAIT: Layout = {
  id: 'portrait',
  backgroundSrc: '/assets/Background.png',
  width: 384,
  height: 640,
  groundSurfaceY: 608,
  spawnX: 96,
  ledges: [
    { key: 'merch', label: 'Merch', surfaceY: 512, x0: 192, x1: 336, chestX: 304, chestY: 496 },
    { key: 'youtube', label: 'YouTube', surfaceY: 400, x0: 0, x1: 144, chestX: 16, chestY: 384 },
    { key: 'featured', label: 'Featured', surfaceY: 304, x0: 176, x1: 272, chestX: 240, chestY: 288 },
    { key: 'streaming', label: 'Listen', surfaceY: 192, x0: 0, x1: 144, chestX: 16, chestY: 176 },
    { key: 'socials', label: 'Instagram', surfaceY: 64, x0: 192, x1: 336, chestX: 272, chestY: 48 },
  ],
  steppingStones: [],
  // Clears the tallest gap (128px, streaming -> socials) with a 146px rise.
  physics: { moveSpeed: 140, jumpVelocity: -520, gravityY: 900 },
};

export const LANDSCAPE: Layout = {
  id: 'landscape',
  backgroundSrc: '/assets/Background-landscape.png',
  width: 768,
  height: 432,
  groundSurfaceY: 400,
  spawnX: 96,
  ledges: [
    { key: 'merch', label: 'Merch', surfaceY: 304, x0: 160, x1: 368, chestX: 288, chestY: 288 },
    { key: 'youtube', label: 'YouTube', surfaceY: 224, x0: 400, x1: 544, chestX: 496, chestY: 208 },
    { key: 'featured', label: 'Featured', surfaceY: 128, x0: 224, x1: 368, chestX: 240, chestY: 112 },
    { key: 'streaming', label: 'Listen', surfaceY: 64, x0: 624, x1: 720, chestX: 672, chestY: 48 },
    { key: 'socials', label: 'Instagram', surfaceY: 48, x0: 32, x1: 176, chestX: 64, chestY: 32 },
  ],
  /*
    Bridges youtube (x 400-544) to the isolated listen ledge (x 624-720); without it that
    ledge needs a 160px rise, well past what the jump can do.

    Drawn at x 576-608, but the collider is widened half a tile each side. At its drawn
    width the landing window is ~233ms against 500-600ms for every other jump in the
    level, and it is the only route to Listen — far too sharp a spike for a casual
    visitor on a touchscreen. The extra 8px takes it to ~333ms. Greg's 32px sprite
    already overhangs every ledge he stands on, so it reads as edge-standing, not air.
  */
  steppingStones: [{ surfaceY: 144, x0: 568, x1: 616 }],
  // Tallest gap here is only 96px, so a 128px rise leaves comfortable margin. Faster walk
  // because the world is twice as wide.
  physics: { moveSpeed: 170, jumpVelocity: -480, gravityY: 900 },
};

/**
 * Chosen by viewport shape rather than device: a phone held landscape should get the wide
 * map, and a narrow desktop window should get the tall one.
 */
export function pickLayout(): Layout {
  return window.innerWidth / window.innerHeight >= 1.2 ? LANDSCAPE : PORTRAIT;
}
