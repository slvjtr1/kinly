// A small in-memory cache with per-entry expiry and a size cap (least recently used goes first).

export class TtlCache<V> {
  private entries = new Map<string, { expires: number; value: V }>();
  constructor(
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size() {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() >= e.expires) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so Map order tracks recent use.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  set(key: string, value: V, ttlMs: number) {
    this.entries.delete(key);
    this.entries.set(key, { expires: this.now() + ttlMs, value });
    if (this.entries.size <= this.max) return;
    const now = this.now();
    for (const [k, e] of this.entries) if (now >= e.expires) this.entries.delete(k);
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(k);
    }
  }

  /** Removes `key` only while it still holds `value` (a newer entry is left alone). */
  deleteIf(key: string, value: V) {
    if (this.entries.get(key)?.value === value) this.entries.delete(key);
  }
}
