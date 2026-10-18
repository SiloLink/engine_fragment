import { describe, expect, it, vi } from "vitest";
import { TileCache } from "./tile-cache";

describe("inactive tile cache", () => {
  it("evicts the oldest inactive geometry within a byte budget", () => {
    const evict = vi.fn();
    const cache = new TileCache<string>(evict);
    cache.setBudget(10);
    cache.retain("a", 6);
    cache.retain("b", 4);
    cache.retain("a", 6); // A passive sweep does not refresh recency.
    cache.retain("c", 5);
    expect(evict.mock.calls).toEqual([["a"]]);
    expect(cache.bytes).toBe(9);

    cache.setBudget(4);
    expect(evict.mock.calls).toEqual([["a"], ["b"], ["c"]]);
    expect(cache.bytes).toBe(0);
  });

  it("starts recency again only after a tile was reactivated", () => {
    const evict = vi.fn();
    const cache = new TileCache<string>(evict);
    cache.setBudget(2);
    cache.retain("a", 1);
    cache.retain("b", 1);
    cache.remove("a");
    expect(cache.bytes).toBe(1);
    cache.retain("a", 1);
    cache.retain("c", 1);
    expect(evict.mock.calls).toEqual([["b"]]);
    expect(cache.bytes).toBe(2);
  });

  it("rejects an oversized tile without evicting useful smaller entries", () => {
    const evict = vi.fn();
    const cache = new TileCache<string>(evict);
    cache.setBudget(2);
    cache.retain("a", 1);
    cache.retain("b", 3);
    expect(evict.mock.calls).toEqual([["b"]]);
    expect(cache.bytes).toBe(1);
  });

  it("does not retain anything when disabled and releases existing entries", () => {
    const evict = vi.fn();
    const cache = new TileCache<string>(evict);
    cache.retain("a", 1);
    expect(evict.mock.calls).toEqual([["a"]]);
    cache.setBudget(1);
    cache.retain("b", 1);
    cache.setBudget(0);
    expect(evict.mock.calls).toEqual([["a"], ["b"]]);
    expect(cache.bytes).toBe(0);
  });

  it("forgets disposal without invoking eviction a second time", () => {
    const evict = vi.fn();
    const cache = new TileCache<string>(evict);
    cache.setBudget(2);
    cache.retain("a", 1);
    cache.clear();
    cache.remove("a");
    cache.setBudget(0);
    expect(cache.bytes).toBe(0);
    expect(evict).not.toHaveBeenCalled();
  });

  it("keeps accounting finite even at the largest accepted budget", () => {
    const evict = vi.fn();
    const cache = new TileCache<string>(evict);
    cache.setBudget(Number.MAX_VALUE);
    cache.retain("a", Number.MAX_VALUE);
    cache.retain("b", Number.MAX_VALUE);
    expect(evict.mock.calls).toEqual([["a"]]);
    expect(cache.bytes).toBe(Number.MAX_VALUE);
  });

  it.each([NaN, Infinity, -Infinity, -1])(
    "rejects an invalid byte count (%s) without changing the cache",
    (bytes) => {
      const evict = vi.fn();
      const cache = new TileCache<string>(evict);
      cache.setBudget(1);
      cache.retain("a", 1);
      expect(() => cache.setBudget(bytes)).toThrow(RangeError);
      expect(() => cache.retain("b", bytes)).toThrow(RangeError);
      expect(cache.bytes).toBe(1);
      expect(evict).not.toHaveBeenCalled();
    },
  );
});
