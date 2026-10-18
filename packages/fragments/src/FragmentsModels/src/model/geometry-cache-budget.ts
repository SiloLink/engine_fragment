type CacheEntry = {
  weight: number;
  apply: (bytes: number) => Promise<void>;
  reserved: number;
  confirmed: boolean;
  retired: boolean;
};

/**
 * Divides a fixed geometry-cache capacity between model lifetimes. Weights are
 * stable byte sizes, independent of the current view or resident tile count.
 * A model must start with no cached geometry before it is registered.
 */
export class GeometryCacheBudget {
  private readonly _entries = new Map<object, CacheEntry>();
  private readonly _retired = new WeakSet<object>();
  private _revision = 0;
  private _pending: Promise<void> = Promise.resolve();
  private _disposed = false;

  constructor(readonly capacityBytes: number) {
    GeometryCacheBudget.validateBytes(capacityBytes, "capacity");
  }

  /**
   * Registers one model lifetime. Repeating a registration retries the current
   * allocation, retaining any reservation left by an earlier failed callback.
   * `apply` must release excess geometry and await its main-thread removal
   * before acknowledging a lower quota.
   */
  async register(
    owner: object,
    weight: number,
    apply: (bytes: number) => Promise<void>,
  ) {
    GeometryCacheBudget.validateBytes(weight, "weight");
    return this.enqueue(async () => {
      if (this._retired.has(owner)) {
        throw new Error(
          "Fragments: a retired geometry-cache owner cannot be registered.",
        );
      }
      const existing = this._entries.get(owner);
      if (existing && existing.weight !== weight) {
        throw new Error(
          "Fragments: a registered geometry-cache weight is immutable.",
        );
      }
      if (!existing) {
        this._entries.set(owner, {
          weight,
          apply,
          reserved: 0,
          confirmed: false,
          retired: false,
        });
      }
      await this.applyAllocation();
    });
  }

  /**
   * Stops further quota callbacks as worker disposal begins. The reservation
   * remains charged until remove(), including when old geometry stays in scene.
   */
  retire(owner: object) {
    if (this._disposed || this._retired.has(owner)) return;
    this._retired.add(owner);
    const entry = this._entries.get(owner);
    if (entry) entry.retired = true;
    this._revision++;
  }

  /**
   * Releases a model's reservation AFTER its worker and cached geometry have
   * been disposed. No callback is made to the removed owner.
   */
  remove(owner: object) {
    return this.enqueue(async () => {
      if (!this._entries.delete(owner)) return;
      await this.applyAllocation();
    });
  }

  /** Retries an allocation after a failed quota update. */
  rebalance() {
    return this.enqueue(() => this.applyAllocation());
  }

  /** Core teardown owns worker disposal; this only closes quota allocation. */
  dispose() {
    this._disposed = true;
    this._entries.clear();
  }

  private enqueue(operation: () => Promise<void>) {
    if (this._disposed) return Promise.reject(this.disposedError());
    const pending = this._pending.then(async () => {
      this.assertOpen();
      await operation();
    });
    // A rejected operation does not poison later retries or model removal.
    this._pending = pending.catch(() => {});
    return pending;
  }

  private async applyAllocation() {
    // retire() is synchronous and may run during an awaited callback. Recompute
    // after it changes reservations rather than applying stale redistribution.
    let revision: number;
    do {
      revision = this._revision;
      const allocations = this.allocate();
      // A failed decrease cannot finance another owner's increase. Unconfirmed
      // unchanged quotas are retried too, before granting additional bytes.
      for (const [entry, bytes] of allocations) {
        if (revision !== this._revision) break;
        if (
          bytes < entry.reserved ||
          (bytes === entry.reserved && !entry.confirmed)
        ) {
          await this.apply(entry, bytes);
        }
      }
      for (const [entry, bytes] of allocations) {
        if (revision !== this._revision) break;
        if (bytes > entry.reserved) await this.apply(entry, bytes);
      }
    } while (revision !== this._revision);
  }

  private async apply(entry: CacheEntry, bytes: number) {
    this.assertOpen();
    entry.confirmed = false;
    // A failed increase may already have reached the worker. Keep its larger
    // reservation until a later acknowledged decrease or model disposal.
    // A failed decrease likewise cannot release the preceding reservation.
    entry.reserved = Math.max(entry.reserved, bytes);
    await entry.apply(bytes);
    this.assertOpen();
    if (entry.retired) return;
    entry.reserved = bytes;
    entry.confirmed = true;
  }

  private allocate() {
    const entries = [...this._entries.values()].filter(
      (entry) => !entry.retired,
    );
    const retired = [...this._entries.values()].reduce(
      (sum, entry) => sum + (entry.retired ? BigInt(entry.reserved) : 0n),
      0n,
    );
    const total = entries.reduce(
      (sum, entry) => sum + BigInt(entry.weight),
      0n,
    );
    const capacity = BigInt(this.capacityBytes) - retired;
    const shares = entries.map((entry, order) => {
      const weighted = capacity * BigInt(entry.weight);
      return {
        entry,
        order,
        bytes: total === 0n ? 0n : weighted / total,
        remainder: total === 0n ? 0n : weighted % total,
      };
    });
    if (total !== 0n) {
      let remaining =
        capacity - shares.reduce((sum, share) => sum + share.bytes, 0n);
      // Largest remainders retain the full integer budget without assigning
      // bytes to zero-weight owners. Insertion order breaks exact ties.
      const ranked = shares
        .filter((share) => share.entry.weight > 0)
        .sort((a, b) => {
          if (a.remainder === b.remainder) return a.order - b.order;
          return a.remainder > b.remainder ? -1 : 1;
        });
      for (const share of ranked) {
        if (remaining === 0n) break;
        share.bytes++;
        remaining--;
      }
    }
    return shares.map(({ entry, bytes }) => [entry, Number(bytes)] as const);
  }

  private assertOpen() {
    if (this._disposed) throw this.disposedError();
  }

  private disposedError() {
    return new Error("Fragments: geometry-cache budget is disposed.");
  }

  private static validateBytes(bytes: number, label: string) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(
        `Fragments: geometry-cache ${label} must be a nonnegative safe integer.`,
      );
    }
  }
}
