import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FragmentsModel } from "./fragments-model";
import { MeshManager } from "./mesh-manager";
import { TileRequestClass } from "./model-types";

let now = 0;

function setup() {
  const updated = vi.fn();
  const meshes = new MeshManager(updated);
  function addModel(modelId: string, cost = 3) {
    const tiles = new Map([1, 2, 3, 4].map((id) => [id, { userData: {} }]));
    const remove = tiles.delete.bind(tiles);
    const applied: number[] = [];
    vi.spyOn(tiles, "delete").mockImplementation((id) => {
      now += cost;
      applied.push(id);
      return remove(id);
    });
    const model = {
      modelId,
      tiles,
      _finishProcessing: vi.fn(),
      _failProcessing: vi.fn(),
    } as unknown as FragmentsModel;
    meshes.list.set(modelId, model);
    const entry = { model, applied, tiles };
    return entry;
  }
  function remove(modelId: string, ...tileIds: number[]) {
    meshes.requests.add(
      tileIds.map((tileId) => ({
        tileRequestClass: TileRequestClass.DELETE,
        modelId,
        tileId,
      })),
    );
  }
  function finish(modelId: string, renderRevision: number) {
    meshes.requests.add([
      {
        tileRequestClass: TileRequestClass.FINISH,
        modelId,
        renderRevision,
      },
    ]);
  }
  return { meshes, updated, addModel, remove, finish };
}

beforeEach(() => {
  now = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("arrival-driven tile consumption", () => {
  it("applies bounded slices, notifies once per changed slice, and goes idle", () => {
    const t = setup();
    const a = t.addModel("a");
    t.remove("a", 1, 2, 3, 4);
    expect(a.applied).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersToNextTimer();
    expect(a.applied).toEqual([1, 2]);
    expect(t.updated).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersToNextTimer();
    expect(a.applied).toEqual([1, 2, 3, 4]);
    expect(t.updated).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes arrivals while a force fence waits, then applies FINISH in order", async () => {
    const t = setup();
    const a = t.addModel("a");
    const revision = t.meshes.beginViewUpdate(a.model);
    const resolved = vi.fn();
    const fence = t.meshes.forceUpdateFinish().then(resolved);
    expect(vi.getTimerCount()).toBe(0);

    t.remove("a", 1, 2);
    vi.advanceTimersToNextTimer();
    expect(a.applied).toEqual([1, 2]);
    expect(resolved).not.toHaveBeenCalled();
    expect(a.model._finishProcessing).not.toHaveBeenCalled();

    t.remove("a", 3, 4);
    t.finish("a", revision);
    expect(a.applied).toEqual([1, 2]);
    vi.advanceTimersToNextTimer();
    expect(a.applied).toEqual([1, 2, 3, 4]);
    expect(a.model._finishProcessing).not.toHaveBeenCalled();
    vi.advanceTimersToNextTimer();
    await fence;
    expect(a.model._finishProcessing).toHaveBeenCalledOnce();
    expect(resolved).toHaveBeenCalledOnce();
    expect(t.updated).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces task scheduling across arrivals and explicit update calls", () => {
    const t = setup();
    const a = t.addModel("a");
    t.remove("a", 1, 2);
    t.remove("a", 3, 4);
    expect(vi.getTimerCount()).toBe(1);
    t.meshes.update();
    expect(a.applied).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(1);
    vi.runAllTimers();
    expect(a.applied).toEqual([1, 2, 3, 4]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for all budgeted slices to become idle without a view FINISH", async () => {
    const t = setup();
    const a = t.addModel("a");
    t.remove("a", 1, 2, 3, 4);
    const resolved = vi.fn();
    const idle = t.meshes.whenIdle().then(resolved);
    vi.advanceTimersToNextTimer();
    await Promise.resolve();
    expect(a.applied).toEqual([1, 2]);
    expect(resolved).not.toHaveBeenCalled();
    vi.advanceTimersToNextTimer();
    await idle;
    expect(a.applied).toEqual([1, 2, 3, 4]);
    expect(resolved).toHaveBeenCalledOnce();
    expect(a.model._finishProcessing).not.toHaveBeenCalled();
    await t.meshes.whenIdle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects queue idle waits when disposed", async () => {
    const t = setup();
    t.addModel("a");
    t.remove("a", 1, 2);
    const idle = expect(t.meshes.whenIdle()).rejects.toThrow("disposed");
    t.meshes.dispose();
    await idle;
    await expect(t.meshes.whenIdle()).rejects.toThrow("disposed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not notify for missing models or tiles", () => {
    const t = setup();
    t.addModel("a");
    t.remove("missing", 1);
    t.remove("a", 99);
    vi.runAllTimers();
    expect(t.updated).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a removed model's pending changes without dropping other models", async () => {
    const t = setup();
    const a = t.addModel("a");
    const b = t.addModel("b");
    t.meshes.beginViewUpdate(a.model);
    const rejected = expect(t.meshes.forceUpdateFinish()).rejects.toMatchObject(
      {
        reason: "model-removed",
        modelId: "a",
      },
    );
    t.remove("a", 1, 2);
    t.remove("b", 1, 2);
    t.meshes.list.delete("a");
    await rejected;
    vi.runAllTimers();
    expect(a.applied).toEqual([]);
    expect(b.applied).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not apply queued geometry to a replacement with the same id", () => {
    const t = setup();
    const old = t.addModel("a");
    t.remove("a", 1, 2);
    const replacement = t.addModel("a");
    vi.runAllTimers();
    expect(old.applied).toEqual([]);
    expect(replacement.applied).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    t.remove("a", 3);
    t.meshes.list.set("a", replacement.model);
    vi.runAllTimers();
    expect(replacement.applied).toEqual([3]);
  });

  it.each(["clear", "dispose"] as const)(
    "%s releases queued geometry, cancels the task, and rejects fences",
    async (operation) => {
      const t = setup();
      const a = t.addModel("a");
      t.meshes.beginViewUpdate(a.model);
      const rejected = expect(
        t.meshes.forceUpdateFinish(),
      ).rejects.toMatchObject({
        reason: "model-removed",
      });
      t.remove("a", 1, 2);
      if (operation === "clear") t.meshes.list.clear();
      else t.meshes.dispose();
      await rejected;
      expect(t.meshes.requests.arePending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      if (operation === "dispose") {
        t.remove("a", 3);
        t.meshes.update();
        expect(t.meshes.requests.arePending).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        await expect(t.meshes.forceUpdateFinish()).rejects.toMatchObject({
          reason: "model-removed",
        });
      }
      expect(a.applied).toEqual([]);
    },
  );

  it("reports a tile failure through its view and keeps other models progressing", async () => {
    const t = setup();
    const a = t.addModel("a");
    const b = t.addModel("b");
    const revision = t.meshes.beginViewUpdate(a.model);
    const rejected = expect(t.meshes.forceUpdateFinish()).rejects.toMatchObject(
      {
        reason: "view-failed",
        modelId: "a",
        renderRevision: revision,
      },
    );
    vi.mocked(a.tiles.delete).mockImplementationOnce(() => {
      throw new Error("invalid geometry");
    });
    t.remove("a", 1, 2);
    t.finish("a", revision);
    t.remove("b", 1);
    const idle = expect(t.meshes.whenIdle()).rejects.toThrow(
      "invalid geometry",
    );
    vi.runAllTimers();
    await Promise.all([rejected, idle]);
    expect(a.model._failProcessing).toHaveBeenCalledOnce();
    expect(a.model._finishProcessing).not.toHaveBeenCalled();
    expect(b.applied).toEqual([1]);

    // A delayed success cannot finish the failed revision; a new view can.
    t.finish("a", revision);
    vi.runAllTimers();
    expect(a.model._finishProcessing).not.toHaveBeenCalled();
    const next = t.meshes.beginViewUpdate(a.model);
    const recovered = t.meshes.forceUpdateFinish();
    t.remove("a", 3);
    t.finish("a", next);
    vi.runAllTimers();
    await recovered;
    expect(a.applied).toEqual([3]);
    expect(a.model._finishProcessing).toHaveBeenCalledOnce();
  });

  it("retains application failures for an idle wait started after the queue emptied", async () => {
    const t = setup();
    const a = t.addModel("a");
    t.meshes.beginViewUpdate(a.model);
    vi.mocked(a.tiles.delete).mockImplementationOnce(() => {
      throw new Error("geometry release failed");
    });
    t.remove("a", 1);
    vi.runAllTimers();
    expect(t.meshes.requests.arePending).toBe(false);
    await expect(t.meshes.whenIdle()).rejects.toThrow(
      "geometry release failed",
    );

    // A fresh view need not re-emit the failed DELETE, so it cannot clear this
    // lifetime's release failure. Disposing the model releases the reservation.
    const next = t.meshes.beginViewUpdate(a.model);
    t.finish("a", next);
    vi.runAllTimers();
    await expect(t.meshes.whenIdle()).rejects.toThrow(
      "geometry release failed",
    );
    t.meshes.list.delete("a");
    await t.meshes.whenIdle();
  });
});
