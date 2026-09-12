const STORAGE_KEY = 'ymi-inventory-v1';

export type ItemId = 'merch' | 'streaming' | 'youtube' | 'socials' | 'featured';

export const ALL_ITEM_IDS: ItemId[] = ['merch', 'streaming', 'youtube', 'socials', 'featured'];

export class Inventory {
  private collected: Set<ItemId>;

  constructor() {
    this.collected = new Set(Inventory.load());
  }

  private static load(): ItemId[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as ItemId[]) : [];
    } catch {
      return [];
    }
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.collected]));
    } catch {
      // localStorage unavailable (e.g. private browsing) — progress just won't persist this session.
    }
  }

  has(item: ItemId): boolean {
    return this.collected.has(item);
  }

  /** Returns true if this item was newly collected (false if already owned). */
  collect(item: ItemId): boolean {
    if (this.collected.has(item)) return false;
    this.collected.add(item);
    this.save();
    return true;
  }

  isComplete(): boolean {
    return ALL_ITEM_IDS.every((id) => this.collected.has(id));
  }
}
