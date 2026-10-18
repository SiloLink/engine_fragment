import { describe, expect, it, vi } from "vitest";
import { GeometryCacheBudget } from "./geometry-cache-budget";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function workers(capacity: number) {
  const budget = new GeometryCacheBudget(capacity);
  const quotas = new Map<object, number>();
  const calls: { owner: object; bytes: number }[] = [];
  const apply = (owner: object) =>
    vi.fn(async (bytes: number) => {
      calls.push({ owner, bytes });
      quotas.set(owner, bytes);
      const total = [...quotas.values()].reduce(
        (sum, value) => sum + BigInt(value),
        0n,
      );
      expect(total).toBeLessThanOrEqual(BigInt(capacity));
    });
  return { budget, quotas, calls, apply };
}

describe("geometry cache allocation", () => {
  it("redistributes proportional integer shares and leaves zero weights at zero", async () => {
    const t = workers(7);
    const a = {};
    const b = {};
    const empty = {};
    await t.budget.register(a, 5, t.apply(a));
    expect(t.quotas.get(a)).toBe(7);
    await t.budget.register(b, 1, t.apply(b));
    await t.budget.register(empty, 0, t.apply(empty));
    expect([...t.quotas.values()]).toEqual([6, 1, 0]);
    const before = t.calls.length;
    await t.budget.rebalance();
    expect(t.calls).toHaveLength(before);
  });

  it("assigns equal remainders deterministically without exceeding the cap", async () => {
    const t = workers(10);
    for (let i = 0; i < 3; i++) {
      const owner = {};
      await t.budget.register(owner, 1, t.apply(owner));
    }
    expect([...t.quotas.values()]).toEqual([4, 3, 3]);
  });

  it("retains exact sums when combined weights exceed Number's safe integer range", async () => {
    const t = workers(Number.MAX_SAFE_INTEGER);
    for (let i = 0; i < 3; i++) {
      const owner = {};
      await t.budget.register(owner, Number.MAX_SAFE_INTEGER, t.apply(owner));
    }
    const quotas = [...t.quotas.values()];
    expect(quotas.every(Number.isSafeInteger)).toBe(true);
    expect(quotas.reduce((sum, bytes) => sum + BigInt(bytes), 0n)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
    expect(Math.max(...quotas) - Math.min(...quotas)).toBe(1);
  });

  it.each([0, 100])(
    "keeps all-zero weights unallocated with capacity %s",
    async (capacity) => {
      const t = workers(capacity);
      for (let i = 0; i < 2; i++) {
        const owner = {};
        await t.budget.register(owner, 0, t.apply(owner));
      }
      expect([...t.quotas.values()]).toEqual([0, 0]);
    },
  );

  it("awaits release acknowledgement before granting another model its share", async () => {
    const t = workers(100);
    const a = {};
    const b = {};
    const entered = gate();
    const release = gate();
    const applyA = t.apply(a);
    await t.budget.register(a, 1, async (bytes) => {
      if (bytes < 100) {
        entered.resolve();
        await release.promise;
      }
      await applyA(bytes);
    });
    const applyB = t.apply(b);
    const registration = t.budget.register(b, 3, applyB);
    await entered.promise;
    expect(t.quotas.get(a)).toBe(100);
    expect(applyB).not.toHaveBeenCalled();
    release.resolve();
    await registration;
    expect([...t.quotas.values()]).toEqual([25, 75]);
    expect(t.calls.map(({ bytes }) => bytes)).toEqual([100, 25, 75]);
  });

  it("retains failed shrink reservations across registrations, then retries", async () => {
    const t = workers(100);
    const a = {};
    const b = {};
    const c = {};
    let fail = false;
    const applyA = t.apply(a);
    const applyB = t.apply(b);
    const applyC = t.apply(c);
    await t.budget.register(a, 1, async (bytes) => {
      if (fail) throw new Error("release failed");
      await applyA(bytes);
    });
    fail = true;
    await expect(t.budget.register(b, 1, applyB)).rejects.toThrow(
      "release failed",
    );
    await expect(t.budget.register(c, 1, applyC)).rejects.toThrow(
      "release failed",
    );
    expect(applyB).not.toHaveBeenCalled();
    expect(applyC).not.toHaveBeenCalled();
    expect(t.quotas.get(a)).toBe(100);
    fail = false;
    await t.budget.register(c, 1, applyC);
    expect([...t.quotas.values()]).toEqual([34, 33, 33]);
  });

  it("reserves failed increases and re-applies uncertain unchanged quotas", async () => {
    const t = workers(100);
    const a = {};
    const applied = t.apply(a);
    let fail = true;
    await expect(
      t.budget.register(a, 1, async (bytes) => {
        await applied(bytes);
        if (fail) throw new Error("acknowledgement lost");
      }),
    ).rejects.toThrow("acknowledgement lost");
    fail = false;
    await t.budget.rebalance();
    expect(applied.mock.calls).toEqual([[100], [100]]);
  });

  it("serializes registrations and removals by model lifetime, not model id", async () => {
    const t = workers(100);
    const first = { modelId: "same" };
    const replacement = { modelId: "same" };
    const firstApply = t.apply(first);
    const replacementApply = t.apply(replacement);
    await Promise.all([
      t.budget.register(first, 1, firstApply),
      t.budget.register(replacement, 1, replacementApply),
    ]);
    expect([...t.quotas.values()]).toEqual([50, 50]);
    const firstCalls = firstApply.mock.calls.length;
    t.quotas.delete(first);
    await t.budget.remove(first);
    expect(firstApply).toHaveBeenCalledTimes(firstCalls);
    expect(t.quotas.get(replacement)).toBe(100);
    await t.budget.remove(first);
    expect(replacementApply.mock.calls).toEqual([[50], [100]]);
  });

  it("charges retired owners until disposal and never calls their worker again", async () => {
    const t = workers(100);
    const a = {};
    const b = {};
    const applyA = t.apply(a);
    const applyB = t.apply(b);
    await t.budget.register(a, 1, applyA);
    t.budget.retire(a);
    await t.budget.register(b, 1, applyB);
    await t.budget.rebalance();
    expect(applyA.mock.calls).toEqual([[100]]);
    expect(t.quotas.get(b)).toBe(0);
    t.quotas.delete(a);
    await t.budget.remove(a);
    expect(t.quotas.get(b)).toBe(100);
  });

  it("retains an uncertain increased reservation when that owner retires", async () => {
    const t = workers(100);
    const a = {};
    const b = {};
    const applyA = t.apply(a);
    const applyB = t.apply(b);
    await expect(
      t.budget.register(a, 1, async (bytes) => {
        await applyA(bytes);
        throw new Error("acknowledgement lost");
      }),
    ).rejects.toThrow("acknowledgement lost");
    t.budget.retire(a);
    await t.budget.register(b, 1, applyB);
    expect(t.quotas.get(b)).toBe(0);
    expect(applyA.mock.calls).toEqual([[100]]);
  });

  it("does not release a retired reservation on a late shrink acknowledgement", async () => {
    const t = workers(100);
    const a = {};
    const b = {};
    const entered = gate();
    const release = gate();
    const applyA = t.apply(a);
    const applyB = t.apply(b);
    await t.budget.register(a, 1, async (bytes) => {
      if (bytes < 100) {
        entered.resolve();
        await release.promise;
      }
      await applyA(bytes);
    });
    const pending = t.budget.register(b, 1, applyB);
    await entered.promise;
    t.budget.retire(a);
    release.resolve();
    await pending;
    expect(applyA.mock.calls).toEqual([[100], [50]]);
    expect(applyB.mock.calls).toEqual([[0]]);
    t.quotas.delete(a);
    await t.budget.remove(a);
    expect(t.quotas.get(b)).toBe(100);
  });

  it("does not start a queued registration after that owner retires", async () => {
    const t = workers(100);
    const a = {};
    const b = {};
    const entered = gate();
    const release = gate();
    const first = t.budget.register(a, 1, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const applyB = t.apply(b);
    const second = expect(t.budget.register(b, 1, applyB)).rejects.toThrow(
      "retired",
    );
    t.budget.retire(b);
    release.resolve();
    await Promise.all([first, second]);
    expect(applyB).not.toHaveBeenCalled();
  });

  it("closes pending and future allocations on disposal without more callbacks", async () => {
    const t = workers(100);
    const entered = gate();
    const release = gate();
    const first = expect(
      t.budget.register({}, 1, async () => {
        entered.resolve();
        await release.promise;
      }),
    ).rejects.toThrow("disposed");
    await entered.promise;
    const next = vi.fn(async () => {});
    const second = expect(t.budget.register({}, 1, next)).rejects.toThrow(
      "disposed",
    );
    t.budget.dispose();
    release.resolve();
    await Promise.all([first, second]);
    expect(next).not.toHaveBeenCalled();
    await expect(t.budget.rebalance()).rejects.toThrow("disposed");
    await expect(t.budget.remove({})).rejects.toThrow("disposed");
    await expect(t.budget.register({}, 1, next)).rejects.toThrow("disposed");
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid capacity and weight %s",
    async (value) => {
      expect(() => new GeometryCacheBudget(value)).toThrow("capacity");
      await expect(
        new GeometryCacheBudget(10).register({}, value, async () => {}),
      ).rejects.toThrow("weight");
    },
  );

  it("rejects changing a registered owner's stable weight", async () => {
    const t = workers(100);
    const owner = {};
    await t.budget.register(owner, 1, t.apply(owner));
    await expect(t.budget.register(owner, 2, t.apply(owner))).rejects.toThrow(
      "immutable",
    );
    expect(t.quotas.get(owner)).toBe(100);
  });
});
