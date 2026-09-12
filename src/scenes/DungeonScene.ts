import Phaser from 'phaser';
import { Inventory, ItemId, ALL_ITEM_IDS } from '../systems/Inventory';
import { trackEvent } from '../systems/analytics';
import { getLinkUrl } from '../systems/links';
import { WORLD_WIDTH, WORLD_HEIGHT, MOVE_SPEED, JUMP_VELOCITY, PROXIMITY_RADIUS } from '../constants';

const FLOOR_HEIGHT = 24;

interface FloorDef {
  key: ItemId;
  itemEmoji: string;
  itemLabel: string;
  promptLabel: string;
  platform: { x: number; y: number; width: number };
  objectX: number;
}

// Placeholder layout: swap platform positions/art once real tiles exist. Bottom = spawn,
// climbing up reaches each destination — matches the confirmed "jump up, not down" design.
const FLOORS: FloorDef[] = [
  { key: 'merch', itemEmoji: '👕', itemLabel: 'T-Shirt', promptLabel: 'Merch Shop', platform: { x: 0, y: 1180, width: 720 }, objectX: 360 },
  { key: 'streaming', itemEmoji: '🎧', itemLabel: 'Headphones', promptLabel: 'Listen', platform: { x: 300, y: 990, width: 420 }, objectX: 610 },
  { key: 'youtube', itemEmoji: '🎸', itemLabel: 'YouTube', promptLabel: 'YouTube', platform: { x: 0, y: 800, width: 420 }, objectX: 110 },
  { key: 'socials', itemEmoji: '🛹', itemLabel: 'Skateboard', promptLabel: 'Instagram', platform: { x: 300, y: 610, width: 420 }, objectX: 610 },
  { key: 'featured', itemEmoji: '🥁', itemLabel: 'Drumsticks', promptLabel: 'Featured', platform: { x: 160, y: 420, width: 400 }, objectX: 360 },
];

interface Hotspot {
  floor: FloorDef;
  obj: Phaser.GameObjects.Text;
  prompt: Phaser.GameObjects.Text;
}

export class DungeonScene extends Phaser.Scene {
  private inventory = new Inventory();

  private player!: Phaser.GameObjects.Text;
  private playerBody!: Phaser.Physics.Arcade.Body;
  private platformRects: Phaser.GameObjects.Rectangle[] = [];
  private hotspots: Hotspot[] = [];
  private nearFloorKey: ItemId | null = null;

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

  create() {
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    this.buildPlatforms();
    this.buildPlayer();
    this.buildHotspots();
    this.setupKeyboard();
    this.setupTouch();
    this.setupCompletionOverlay();

    this.renderInventoryUI();
  }

  update() {
    const left = this.cursors.left.isDown || this.keys.A.isDown || this.leftHeld;
    const right = this.cursors.right.isDown || this.keys.D.isDown || this.rightHeld;

    if (left && !right) {
      this.playerBody.setVelocityX(-MOVE_SPEED);
    } else if (right && !left) {
      this.playerBody.setVelocityX(MOVE_SPEED);
    } else {
      this.playerBody.setVelocityX(0);
    }

    const jumpPressed =
      Phaser.Input.Keyboard.JustDown(this.cursors.up) ||
      Phaser.Input.Keyboard.JustDown(this.keys.W) ||
      Phaser.Input.Keyboard.JustDown(this.keys.SPACE) ||
      this.swipeJumpRequested;
    this.swipeJumpRequested = false;

    if (jumpPressed && this.playerBody.blocked.down) {
      this.playerBody.setVelocityY(JUMP_VELOCITY);
    }

    this.updateProximity();
  }

  private buildPlatforms() {
    for (const floor of FLOORS) {
      const rect = this.add.rectangle(
        floor.platform.x + floor.platform.width / 2,
        floor.platform.y,
        floor.platform.width,
        FLOOR_HEIGHT,
        0x4a3728
      );
      this.physics.add.existing(rect, true);
      this.platformRects.push(rect);
    }
  }

  private buildPlayer() {
    const spawn = FLOORS[0];
    this.player = this.add
      .text(spawn.objectX - 120, spawn.platform.y - 60, '💀', { fontSize: '56px' })
      .setOrigin(0.5);
    this.physics.add.existing(this.player);
    this.playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    this.playerBody.setSize(40, 50);
    this.playerBody.setCollideWorldBounds(true);

    this.physics.add.collider(this.player, this.platformRects);
  }

  private buildHotspots() {
    for (const floor of FLOORS) {
      const obj = this.add
        .text(floor.objectX, floor.platform.y - 40, floor.itemEmoji, { fontSize: '44px' })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      if (this.inventory.has(floor.key)) {
        obj.setAlpha(0.45);
      }

      obj.on('pointerdown', () => {
        if (this.nearFloorKey === floor.key) {
          this.visitLink(floor, obj);
        }
      });

      const prompt = this.add
        .text(floor.objectX, floor.platform.y - 88, `Tap: ${floor.promptLabel}`, {
          fontSize: '18px',
          color: '#ffe66d',
          backgroundColor: '#000000aa',
          padding: { x: 8, y: 4 },
        })
        .setOrigin(0.5)
        .setVisible(false);

      this.hotspots.push({ floor, obj, prompt });
    }
  }

  private setupKeyboard() {
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys('W,A,D,SPACE') as typeof this.keys;
  }

  private setupTouch() {
    // Hold left/right half of the screen to move, swipe up to jump, tap a hotspot to interact.
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const hit = this.input.hitTestPointer(pointer);
      if (hit.length > 0) return; // a hotspot's own handler deals with this tap instead

      this.touchStartY = pointer.y;
      this.touchStartTime = this.time.now;
      if (pointer.x < WORLD_WIDTH / 2) {
        this.leftHeld = true;
      } else {
        this.rightHeld = true;
      }
    });

    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      const dy = pointer.y - this.touchStartY;
      const dt = this.time.now - this.touchStartTime;
      if (dy < -60 && dt < 400) {
        this.swipeJumpRequested = true;
      }
      this.leftHeld = false;
      this.rightHeld = false;
    });

    this.input.on('gameout', () => {
      this.leftHeld = false;
      this.rightHeld = false;
    });
  }

  private setupCompletionOverlay() {
    const closeBtn = document.getElementById('completion-close');
    const overlay = document.getElementById('completion-overlay');
    closeBtn?.addEventListener('click', () => overlay?.classList.remove('visible'));
  }

  private updateProximity() {
    let nearestKey: ItemId | null = null;
    let nearestDist = Infinity;

    for (const { floor, obj, prompt } of this.hotspots) {
      const dist = Phaser.Math.Distance.Between(this.player.x, this.player.y, obj.x, obj.y);
      const isNear = dist < PROXIMITY_RADIUS;
      prompt.setVisible(isNear);
      if (isNear && dist < nearestDist) {
        nearestDist = dist;
        nearestKey = floor.key;
      }
    }
    this.nearFloorKey = nearestKey;
  }

  private visitLink(floor: FloorDef, hotspotObj: Phaser.GameObjects.Text) {
    window.open(getLinkUrl(floor.key), '_blank', 'noopener');
    trackEvent(`visit_${floor.key}`);

    const isNew = this.inventory.collect(floor.key);
    if (isNew) {
      hotspotObj.setAlpha(0.45);
      this.renderInventoryUI();
      if (this.inventory.isComplete()) {
        this.showCompletion();
      }
    }
  }

  private renderInventoryUI() {
    const strip = document.getElementById('inventory-strip');
    if (!strip) return;
    strip.innerHTML = '';
    for (const key of ALL_ITEM_IDS) {
      const floor = FLOORS.find((f) => f.key === key)!;
      const slot = document.createElement('div');
      slot.className = 'item-slot' + (this.inventory.has(key) ? ' collected' : '');
      slot.title = floor.itemLabel;
      slot.textContent = floor.itemEmoji;
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
