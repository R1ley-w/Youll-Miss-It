import Phaser from 'phaser';
import { Inventory, ItemId, ALL_ITEM_IDS } from '../systems/Inventory';
import { trackEvent } from '../systems/analytics';
import { getLinkUrl } from '../systems/links';
import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  MOVE_SPEED,
  JUMP_VELOCITY,
  PROXIMITY_RADIUS,
  TILE,
} from '../constants';

// Survives the tab being evicted while the visitor is off on Spotify/YouTube, so the
// prize sequence still fires when they come back.
const PENDING_KEY = 'ymi-pending-v1';

const GROUND_SURFACE_Y = 608;
const SEQUENCE_MS = 1000;

interface Ledge {
  key: ItemId;
  label: string;
  surfaceY: number;
  x0: number;
  x1: number;
  chestX: number;
  chestY: number;
}

// Derived from Background.png's 16px tile grid. surfaceY is the walkable top edge;
// each chest sits exactly one tile above it.
const LEDGES: Ledge[] = [
  { key: 'merch', label: 'Merch', surfaceY: 512, x0: 192, x1: 336, chestX: 304, chestY: 496 },
  { key: 'youtube', label: 'YouTube', surfaceY: 400, x0: 0, x1: 144, chestX: 16, chestY: 384 },
  { key: 'featured', label: 'Featured', surfaceY: 304, x0: 176, x1: 272, chestX: 240, chestY: 288 },
  { key: 'streaming', label: 'Listen', surfaceY: 192, x0: 0, x1: 144, chestX: 16, chestY: 176 },
  { key: 'socials', label: 'Instagram', surfaceY: 64, x0: 192, x1: 336, chestX: 272, chestY: 48 },
];

const PRIZE_SRC: Record<ItemId, string> = {
  merch: '/assets/prizes/Shirt.png',
  youtube: '/assets/prizes/Guitar.png',
  streaming: '/assets/prizes/Headphones.png',
  socials: '/assets/prizes/Skateboard.png',
  featured: '/assets/prizes/Drumsticks.png',
};

const prizeTexture = (id: ItemId) => `prize_${id}`;

function setPending(id: ItemId) {
  try {
    localStorage.setItem(PENDING_KEY, id);
  } catch {
    // Private browsing — the reward just won't survive the round trip.
  }
}

function takePending(): ItemId | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw) localStorage.removeItem(PENDING_KEY);
    return ALL_ITEM_IDS.includes(raw as ItemId) ? (raw as ItemId) : null;
  } catch {
    return null;
  }
}

export class DungeonScene extends Phaser.Scene {
  private inventory = new Inventory();

  private player!: Phaser.Physics.Arcade.Sprite;
  private playerBody!: Phaser.Physics.Arcade.Body;
  private platforms: Phaser.GameObjects.Rectangle[] = [];
  private openedChests = new Map<ItemId, Phaser.GameObjects.Image>();
  private prompt!: Phaser.GameObjects.Text;
  private nearLedge: Ledge | null = null;
  private sequenceRunning = false;
  private hintDismissed = false;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
    SPACE: Phaser.Input.Keyboard.Key;
  };

  private leftHeld = false;
  private rightHeld = false;
  private touchStartY = 0;
  private touchStartTime = 0;
  private swipeJumpRequested = false;

  constructor() {
    super('DungeonScene');
  }

  preload() {
    this.load.image('bg', '/assets/Background.png');
    this.load.image('opened_chest', '/assets/opened_chest.png');

    for (const id of ALL_ITEM_IDS) {
      this.load.image(prizeTexture(id), PRIZE_SRC[id]);
    }

    const sets: [string, string, number][] = [
      ['rest', 'resting_animation/Resting', 14],
      ['run', 'running_animation/Running', 11],
      ['jump', 'jumping_animation/Jumping', 8],
      ['reward', 'prize_animation/Prize', 8],
    ];
    for (const [key, path, count] of sets) {
      for (let i = 1; i <= count; i++) {
        this.load.image(`${key}_${i}`, `/assets/greg_animation/${path}-${i}.png`);
      }
    }
  }

  create() {
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.add.image(0, 0, 'bg').setOrigin(0, 0).setDepth(-10);

    this.buildAnimations();
    this.buildPlatforms();
    this.buildChests();
    this.buildPlayer();
    this.buildPrompt();
    this.setupKeyboard();
    this.setupPointer();
    this.setupFooterLinks();
    this.setupReturnHandler();
    this.setupCompletionOverlay();

    this.renderInventoryUI();

    // Covers the case where the tab was evicted and reloaded while they were away.
    this.checkPending();
  }

  update() {
    if (this.sequenceRunning) {
      this.playerBody.setVelocityX(0);
      this.updateProximity();
      return;
    }

    const left = this.cursors.left.isDown || this.keys.A.isDown || this.leftHeld;
    const right = this.cursors.right.isDown || this.keys.D.isDown || this.rightHeld;

    if (left && !right) {
      this.playerBody.setVelocityX(-MOVE_SPEED);
      this.player.setFlipX(true);
    } else if (right && !left) {
      this.playerBody.setVelocityX(MOVE_SPEED);
      this.player.setFlipX(false);
    } else {
      this.playerBody.setVelocityX(0);
    }

    const jumpPressed =
      Phaser.Input.Keyboard.JustDown(this.cursors.up) ||
      Phaser.Input.Keyboard.JustDown(this.keys.W) ||
      Phaser.Input.Keyboard.JustDown(this.keys.SPACE) ||
      this.swipeJumpRequested;
    this.swipeJumpRequested = false;

    const onGround = this.playerBody.blocked.down;
    if (jumpPressed && onGround) {
      this.playerBody.setVelocityY(JUMP_VELOCITY);
    }

    if (left || right || jumpPressed) this.dismissHint();

    this.updateAnimation(onGround, left || right);
    this.updateProximity();
  }

  private buildAnimations() {
    const defs: [string, string, number, number, number][] = [
      // key, framePrefix, frameCount, frameRate, repeat
      ['rest', 'rest', 14, 8, -1],
      ['run', 'run', 11, 14, -1],
      ['jump', 'jump', 8, 12, 0],
      ['reward', 'reward', 8, 9, 0],
    ];
    for (const [key, prefix, count, frameRate, repeat] of defs) {
      this.anims.create({
        key,
        frames: Array.from({ length: count }, (_, i) => ({ key: `${prefix}_${i + 1}` })),
        frameRate,
        repeat,
      });
    }
  }

  private buildPlatforms() {
    const surfaces = [
      { x0: 0, x1: WORLD_WIDTH, y: GROUND_SURFACE_Y, oneWay: false },
      ...LEDGES.map((l) => ({ x0: l.x0, x1: l.x1, y: l.surfaceY, oneWay: true })),
    ];
    for (const s of surfaces) {
      const width = s.x1 - s.x0;
      const rect = this.add.rectangle(s.x0 + width / 2, s.y + TILE / 2, width, TILE);
      rect.setVisible(false);
      this.physics.add.existing(rect, true);

      if (s.oneWay) {
        // Land on top, pass through from below or the side. Without this you bonk your head
        // on any ledge you jump under, which makes the climb needlessly fussy on a touchscreen.
        const body = rect.body as Phaser.Physics.Arcade.StaticBody;
        body.checkCollision.down = false;
        body.checkCollision.left = false;
        body.checkCollision.right = false;
      }

      this.platforms.push(rect);
    }
  }

  private buildChests() {
    for (const ledge of LEDGES) {
      const img = this.add
        .image(ledge.chestX + TILE / 2, ledge.chestY + TILE / 2, 'opened_chest')
        .setDepth(0)
        .setVisible(this.inventory.has(ledge.key));
      this.openedChests.set(ledge.key, img);
    }
  }

  private buildPlayer() {
    this.player = this.physics.add.sprite(96, GROUND_SURFACE_Y - 16, 'rest_1').setDepth(10);
    this.playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    this.playerBody.setSize(12, 24);
    this.playerBody.setOffset(10, 8);
    this.playerBody.setCollideWorldBounds(true);
    this.physics.add.collider(this.player, this.platforms);
    this.player.play('rest');
  }

  private buildPrompt() {
    this.prompt = this.add
      .text(0, 0, '', {
        fontSize: '10px',
        fontFamily: 'Courier New, monospace',
        color: '#ffe66d',
        backgroundColor: '#000000cc',
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5, 1)
      .setDepth(15)
      .setVisible(false);
  }

  private setupKeyboard() {
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys('W,A,D,SPACE') as typeof this.keys;
  }

  private setupPointer() {
    // Hold a screen half to move, swipe up to jump, tap a chest you're standing at to open it.
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.sequenceRunning) return;

      if (this.nearLedge && this.isChestTap(pointer, this.nearLedge)) {
        this.visit(this.nearLedge);
        return;
      }

      this.touchStartY = pointer.y;
      this.touchStartTime = this.time.now;
      if (pointer.worldX < WORLD_WIDTH / 2) {
        this.leftHeld = true;
      } else {
        this.rightHeld = true;
      }
    });

    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      const dy = pointer.y - this.touchStartY;
      const dt = this.time.now - this.touchStartTime;
      if (dy < -40 && dt < 400) this.swipeJumpRequested = true;
      this.leftHeld = false;
      this.rightHeld = false;
    });

    this.input.on('gameout', () => {
      this.leftHeld = false;
      this.rightHeld = false;
    });
  }

  /** Generous tap target around the 16px chest — a bare 16px box is far too small on a phone. */
  private isChestTap(pointer: Phaser.Input.Pointer, ledge: Ledge): boolean {
    const cx = ledge.chestX + TILE / 2;
    const cy = ledge.chestY + TILE / 2;
    return Math.abs(pointer.worldX - cx) <= 20 && Math.abs(pointer.worldY - cy) <= 20;
  }

  private setupFooterLinks() {
    const links = document.querySelectorAll<HTMLAnchorElement>('#footer-links a[data-key]');
    links.forEach((link) => {
      link.addEventListener('click', () => {
        const key = link.dataset.key as ItemId;
        if (!ALL_ITEM_IDS.includes(key)) return;
        if (!this.inventory.has(key)) setPending(key);
        trackEvent(`visit_${key}`);
      });
    });
  }

  private setupReturnHandler() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.checkPending();
    });
  }

  private setupCompletionOverlay() {
    const overlay = document.getElementById('completion-overlay');
    document
      .getElementById('completion-close')
      ?.addEventListener('click', () => overlay?.classList.remove('visible'));
  }

  private updateAnimation(onGround: boolean, moving: boolean) {
    const want = !onGround ? 'jump' : moving ? 'run' : 'rest';
    if (this.player.anims.currentAnim?.key !== want) {
      this.player.play(want, true);
    }
  }

  private updateProximity() {
    let nearest: Ledge | null = null;
    let nearestDist = Infinity;

    for (const ledge of LEDGES) {
      const dist = Phaser.Math.Distance.Between(
        this.player.x,
        this.player.y,
        ledge.chestX + TILE / 2,
        ledge.chestY + TILE / 2
      );
      if (dist < PROXIMITY_RADIUS && dist < nearestDist) {
        nearestDist = dist;
        nearest = ledge;
      }
    }

    this.nearLedge = nearest;

    if (!nearest || this.sequenceRunning) {
      this.prompt.setVisible(false);
      return;
    }

    const opened = this.inventory.has(nearest.key);
    this.prompt
      .setText(opened ? `Tap: ${nearest.label}` : `Tap to open: ${nearest.label}`)
      .setPosition(nearest.chestX + TILE / 2, nearest.chestY - 4)
      .setVisible(true);
  }

  private visit(ledge: Ledge) {
    trackEvent(`visit_${ledge.key}`);
    if (!this.inventory.has(ledge.key)) setPending(ledge.key);
    window.open(getLinkUrl(ledge.key), '_blank', 'noopener');
  }

  private checkPending() {
    if (this.sequenceRunning) return;
    const id = takePending();
    if (!id || this.inventory.has(id)) return;
    this.runRewardSequence(id);
  }

  /** Reward beat, played on return to the tab so it isn't wasted on a backgrounded page. */
  private runRewardSequence(id: ItemId) {
    this.sequenceRunning = true;
    this.leftHeld = false;
    this.rightHeld = false;
    this.playerBody.setVelocityX(0);
    this.prompt.setVisible(false);

    this.player.play('reward', true);

    const prize = this.add
      .image(this.player.x, this.player.y - 22, prizeTexture(id))
      .setDepth(20);
    this.tweens.add({
      targets: prize,
      y: prize.y - 18,
      alpha: { from: 1, to: 0 },
      duration: SEQUENCE_MS - 100,
      ease: 'Sine.easeOut',
      onComplete: () => prize.destroy(),
    });

    this.time.delayedCall(SEQUENCE_MS, () => {
      this.inventory.collect(id);
      this.openedChests.get(id)?.setVisible(true);
      this.renderInventoryUI();
      this.sequenceRunning = false;
      if (this.inventory.isComplete()) this.showCompletion();
    });
  }

  private dismissHint() {
    if (this.hintDismissed) return;
    this.hintDismissed = true;
    document.getElementById('control-hint')?.classList.add('hidden');
  }

  private renderInventoryUI() {
    const strip = document.getElementById('inventory-strip');
    if (!strip) return;
    strip.innerHTML = '';
    for (const id of ALL_ITEM_IDS) {
      const ledge = LEDGES.find((l) => l.key === id)!;
      const slot = document.createElement('div');
      slot.className = 'item-slot' + (this.inventory.has(id) ? ' collected' : '');
      slot.title = ledge.label;

      const img = document.createElement('img');
      img.src = PRIZE_SRC[id];
      img.alt = ledge.label;
      slot.appendChild(img);
      strip.appendChild(slot);
    }
  }

  private showCompletion() {
    trackEvent('collection_complete');
    document.getElementById('completion-overlay')?.classList.add('visible');
    this.spawnConfetti();
  }

  private spawnConfetti() {
    const colors = ['#ff5566', '#ffd166', '#06d6a0', '#4cc9f0', '#c77dff'];
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDelay = Math.random() * 0.4 + 's';
      piece.style.animationDuration = 2 + Math.random() * 1.5 + 's';
      document.body.appendChild(piece);
      piece.addEventListener('animationend', () => piece.remove());
    }
  }
}
