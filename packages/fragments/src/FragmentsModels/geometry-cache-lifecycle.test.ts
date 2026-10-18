import { afterEach, describe, expect, it, vi } from "vitest";
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera } from "three";
import { FragmentsModels } from "./index";
import { FragmentsModel } from "./src/model/fragments-model";
import { MultiThreadingRequestClass } from "./src/model/model-types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Lifetime = {
  model: FragmentsModel;
  weight: number;
  quota: number;
  live: boolean;
  finished: boolean;
};
type Call = { kind: string; owner: Lifetime; bytes?: number };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) await finish();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600 });
  const core = new FragmentsModels("worker.mjs", {
    maxCachedGeometryBytes: 100,
  });
  core.settings.autoCoordinate = false;
  const live = new Map<string, Lifetime>();
  const lifetimes: Lifetime[] = [];
  const calls: Call[] = [];
  const weights = new Map<string, number>();
  const sizeGates = new Map<string, ReturnType<typeof deferred>>();
  const quotaGates = new Map<string, ReturnType<typeof deferred>>();
  const deleteGates = new Map<string, ReturnType<typeof deferred>>();
  const threads = (core as any)._connection;

  vi.spyOn(FragmentsModel.prototype, "_setup").mockImplementation(
    async function setupModel(this: FragmentsModel) {
      const owner = {
        model: this,
        weight: weights.get(this.modelId) ?? 1,
        quota: 0,
        live: true,
        finished: false,
      };
      this.onDisposed.add(() => {
        owner.finished = true;
      });
      live.set(this.modelId, owner);
      lifetimes.push(owner);
    },
  );
  vi.spyOn(threads, "invoke").mockImplementation(async (...args: unknown[]) => {
    const [id, method, params] = args as [string, string, number[]];
    const owner = live.get(id)!;
    if (method === "getGeometryCacheSize") {
      calls.push({ kind: "size", owner });
      await sizeGates.get(id)?.promise;
      return owner.weight;
    }
    if (method === "setGeometryCacheBudget") {
      expect(owner.live, "quota must not reach a released worker").toBe(true);
      calls.push({ kind: "quota-start", owner, bytes: params[0] });
      await quotaGates.get(id)?.promise;
      owner.quota = params[0];
      calls.push({ kind: "quota-applied", owner, bytes: params[0] });
      return undefined;
    }
    throw new Error(`Unexpected worker invocation: ${method}`);
  });
  vi.spyOn(threads, "fetch").mockImplementation(async (...args: unknown[]) => {
    const [request] = args as [
      { class: MultiThreadingRequestClass; modelId: string },
    ];
    const owner = live.get(request.modelId)!;
    if (request.class === MultiThreadingRequestClass.REFRESH_VIEW) {
      calls.push({ kind: "view", owner });
      return {};
    }
    if (request.class === MultiThreadingRequestClass.DELETE_MODEL) {
      if (owner?.live) {
        calls.push({ kind: "delete", owner });
        await deleteGates.get(request.modelId)?.promise;
      }
      return {};
    }
    throw new Error(`Unexpected worker request: ${request.class}`);
  });
  vi.spyOn(threads, "delete").mockImplementation((...args: unknown[]) => {
    const owner = live.get(args[0] as string);
    if (owner) owner.live = false;
  });
  cleanup.push(async () => {
    for (const gates of [sizeGates, quotaGates, deleteGates]) {
      for (const gate of gates.values()) gate.resolve();
    }
    await core.dispose();
    for (const owner of lifetimes) {
      if (!owner.finished) owner.model.finalizeDispose();
    }
  });
  const load = (id: string, weight = 1, frozen = false) => {
    weights.set(id, weight);
    return core.load(new Uint8Array([0]), {
      modelId: id,
      raw: true,
      camera: new PerspectiveCamera(),
      viewSize: 800,
      frozen,
    });
  };
  const idle = () => (core as any)._geometryCache._pending as Promise<void>;
  const quotas = () => calls.filter((call) => call.kind === "quota-applied");
  return {
    core,
    load,
    live,
    lifetimes,
    calls,
    sizeGates,
    quotaGates,
    deleteGates,
    idle,
    quotas,
  };
}

describe("geometry cache across real core/model lifetimes", () => {
  it("applies the first quota before unfreezing and requesting a view", async () => {
    const f = setup();
    const gate = deferred();
    f.quotaGates.set("a", gate);
    const loaded = vi.fn();
    f.core.onModelLoaded.add(loaded);
    const loading = f.load("a");
    await vi.waitFor(() =>
      expect(f.calls.some((call) => call.kind === "quota-start")).toBe(true),
    );
    expect(f.core.models.list.get("a")!.frozen).toBe(true);
    expect(f.calls.some((call) => call.kind === "view")).toBe(false);
    expect(loaded).not.toHaveBeenCalled();
    gate.resolve();
    await loading;
    expect(f.calls.map((call) => call.kind)).toEqual([
      "size",
      "quota-start",
      "quota-applied",
      "view",
    ]);
    expect(loaded).toHaveBeenCalledOnce();
  });

  it("shares capacity by model geometry and waits for a decrease before granting bytes", async () => {
    const f = setup();
    await f.load("small", 1, true);
    const gate = deferred();
    f.quotaGates.set("small", gate);
    const loading = f.load("large", 3, true);
    await vi.waitFor(() =>
      expect(
        f.calls.some(
          (c) => c.owner.model.modelId === "small" && c.bytes === 25,
        ),
      ).toBe(true),
    );
    expect(f.live.get("small")!.quota).toBe(100);
    expect(f.quotas().some((c) => c.owner.model.modelId === "large")).toBe(
      false,
    );
    gate.resolve();
    await loading;
    expect(f.live.get("small")!.quota).toBe(25);
    expect(f.live.get("large")!.quota).toBe(75);
    expect(f.calls.some((c) => c.kind === "view")).toBe(false);
  });

  it("holds an editor replacement's reservation until old geometry is finalized", async () => {
    const f = setup();
    const old = await f.load("edited", 1, true);
    const oldOwner = f.live.get("edited")!;
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial();
    const disposed = vi.fn(() =>
      f.calls.push({ kind: "geometry-disposed", owner: oldOwner }),
    );
    geometry.addEventListener("dispose", disposed);
    old.tiles.set(1, new Mesh(geometry, material) as any);
    await old.dispose({ keepInScene: true });
    expect(disposed).not.toHaveBeenCalled();

    const replacement = await f.load("edited", 3, true);
    const newOwner = f.live.get("edited")!;
    expect(newOwner.model).toBe(replacement);
    expect(newOwner).not.toBe(oldOwner);
    expect(newOwner.quota).toBe(0);
    expect(
      f.calls.filter((c) => c.kind === "quota-start" && c.owner === oldOwner),
    ).toHaveLength(1);

    old.finalizeDispose();
    await f.idle();
    expect(disposed).toHaveBeenCalledOnce();
    expect(newOwner.quota).toBe(100);
    const release = f.calls.findIndex((c) => c.kind === "geometry-disposed");
    const increase = f.calls.findIndex(
      (c) =>
        c.kind === "quota-start" && c.owner === newOwner && c.bytes === 100,
    );
    expect(increase).toBeGreaterThan(release);
    material.dispose();
  });

  it("retires callbacks as disposal starts but retains their allowance while deletion waits", async () => {
    const f = setup();
    const first = await f.load("a", 1, true);
    const gate = deferred();
    f.deleteGates.set("a", gate);
    const disposing = first.dispose();
    await f.load("b", 1, true);
    expect(f.live.get("b")!.quota).toBe(0);
    expect(
      f.calls.filter(
        (c) => c.kind === "quota-start" && c.owner.model === first,
      ),
    ).toHaveLength(1);
    gate.resolve();
    await disposing;
    await f.idle();
    expect(f.live.get("b")!.quota).toBe(100);
  });

  it("does not register a model disposed while its geometry size is in flight", async () => {
    const f = setup();
    const gate = deferred();
    f.sizeGates.set("a", gate);
    const loading = f.load("a");
    const rejected = expect(loading).rejects.toThrow(/disposed/);
    await vi.waitFor(() =>
      expect(f.calls.some((c) => c.kind === "size")).toBe(true),
    );
    await f.core.disposeModel("a");
    gate.resolve();
    await rejected;
    await f.idle();
    expect(f.quotas()).toHaveLength(0);
    expect(f.calls.some((c) => c.kind === "view")).toBe(false);
    expect(f.core.models.list.has("a")).toBe(false);
  });

  it("does not publish or unfreeze a load disposed during its quota acknowledgement", async () => {
    const f = setup();
    const gate = deferred();
    f.quotaGates.set("a", gate);
    const loaded = vi.fn();
    f.core.onModelLoaded.add(loaded);
    const loading = f.load("a");
    const rejected = expect(loading).rejects.toThrow(/disposed|retired/);
    await vi.waitFor(() =>
      expect(f.calls.some((c) => c.kind === "quota-start")).toBe(true),
    );
    await f.core.disposeModel("a");
    gate.resolve();
    await rejected;
    await f.idle();
    expect(loaded).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.kind === "view")).toBe(false);
    expect(f.core.models.list.has("a")).toBe(false);
  });

  it("does not let cleanup of an obsolete load delete a replacement with the same ID", async () => {
    const f = setup();
    const gate = deferred();
    f.sizeGates.set("a", gate);
    const obsolete = f.load("a");
    const rejected = expect(obsolete).rejects.toThrow(/disposed/);
    await vi.waitFor(() =>
      expect(f.calls.some((c) => c.kind === "size")).toBe(true),
    );
    await f.core.disposeModel("a");
    f.sizeGates.delete("a");
    const replacement = await f.load("a", 3, true);
    const owner = f.live.get("a")!;
    gate.resolve();
    await rejected;
    await f.idle();
    expect(f.core.models.list.get("a")).toBe(replacement);
    expect(owner.live).toBe(true);
    expect(owner.quota).toBe(100);
    expect(
      f.calls.filter((c) => c.kind === "delete" && c.owner === owner),
    ).toHaveLength(0);
  });

  it("rejects an in-flight load when the entire core is disposed", async () => {
    const f = setup();
    const gate = deferred();
    f.sizeGates.set("a", gate);
    const loading = f.load("a");
    const rejected = expect(loading).rejects.toThrow(/disposed/);
    await vi.waitFor(() =>
      expect(f.calls.some((c) => c.kind === "size")).toBe(true),
    );
    await f.core.dispose();
    gate.resolve();
    await rejected;
    expect(f.quotas()).toHaveLength(0);
    expect(f.calls.some((c) => c.kind === "view")).toBe(false);
  });
});
