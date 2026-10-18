/**
 * A byte-bounded cache for geometry that is resident but no longer drawn.
 * Entries are ordered by their transition to inactivity. Repeated retention
 * checks do not refresh that order; making an entry active removes it.
 */
export class TileCache<T> {
  private readonly _entries = new Map<T, number>();
  private _budget = 0;
  private _bytes = 0;

  constructor(private readonly evict: (entry: T) => void) {}

  get bytes() {
    return this._bytes;
  }

  setBudget(bytes: number) {
    TileCache.validateBytes(bytes);
    this._budget = bytes;
    this.trim();
  }

  retain(entry: T, bytes: number) {
    TileCache.validateBytes(bytes);
    if (this._entries.has(entry)) return;
    // A tile that cannot fit must not evict useful, smaller cached tiles.
    if (bytes > this._budget || this._budget === 0) {
      this.evict(entry);
      return;
    }
    // Make room before adding so even very large finite budgets cannot
    // overflow the accounting sum while temporarily exceeding the limit.
    this.trim(this._budget - bytes);
    this._entries.set(entry, bytes);
    this._bytes += bytes;
  }

  remove(entry: T) {
    const bytes = this._entries.get(entry);
    if (bytes === undefined) return;
    this._entries.delete(entry);
    this._bytes -= bytes;
  }

  /** For disposal: forget entries without sending individual evictions. */
  clear() {
    this._entries.clear();
    this._bytes = 0;
  }

  private trim(limit = this._budget) {
    while (this._bytes > limit) {
      const entry = this._entries.keys().next().value!;
      this.remove(entry);
      this.evict(entry);
    }
  }

  private static validateBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError(
        "Fragments: tile cache bytes must be finite and non-negative.",
      );
    }
  }
}
