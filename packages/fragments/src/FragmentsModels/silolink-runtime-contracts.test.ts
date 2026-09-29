import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FragmentsModels } from "./index";
import { FragmentsModel } from "./src/model/fragments-model";
import {
  CurrentLod,
  MultiThreadingRequestClass,
  TileRequestClass,
} from "./src/model/model-types";
import { GPU } from "./src/utils";
import { VirtualTilesController } from "./src/virtual-model/virtual-controllers/virtual-tiles-controller";

describe("SiloLink Fragments runtime contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("batches wire LODs more broadly without changing geometry tile size", () => {
    const controller = Object.create(VirtualTilesController.prototype) as any;
    controller._tileDimension = 32;
    controller._params = {
      tileSizeMultiplier: 10,
      wireTileSizeMultiplier: 2,
    };
    const getTileDimension = (VirtualTilesController.prototype as any)
      .getTileDimension as (lod: CurrentLod) => number;

    expect(getTileDimension.call(controller, CurrentLod.WIRES)).toBe(64);
    expect(getTileDimension.call(controller, CurrentLod.GEOMETRY)).toBe(320);
  });

  it("rate-limits ordinary refreshes without skipping a forced fence", async () => {
    const refreshView = vi.fn(async () => undefined);
    const updateMeshes = vi.fn();
    const forceUpdateFinish = vi.fn(async () => undefined);
    const fragments = {
      _isDisposed: false,
      _lastUpdate: performance.now(),
      settings: { maxUpdateRate: 10_000 },
      models: {
        list: new Map([["model", { _refreshView: refreshView }]]),
        update: updateMeshes,
        forceUpdateFinish,
      },
    };

    await FragmentsModels.prototype.update.call(
      fragments as unknown as FragmentsModels,
      false,
    );
    expect(refreshView).not.toHaveBeenCalled();

    await FragmentsModels.prototype.update.call(
      fragments as unknown as FragmentsModels,
      true,
    );
    expect(refreshView).toHaveBeenCalledOnce();
    expect(forceUpdateFinish).toHaveBeenCalledOnce();
    expect(updateMeshes).not.toHaveBeenCalled();
  });

  it("binds screen-space LOD to the owning viewport size", () => {
    const camera = new THREE.PerspectiveCamera();
    const useCamera = vi.fn();
    const model = { _viewManager: { useCamera } };
    const bindCamera = FragmentsModel.prototype.useCamera as unknown as (
      this: FragmentsModel,
      camera: THREE.PerspectiveCamera,
      viewSize: number,
    ) => void;

    bindCamera.call(model as unknown as FragmentsModel, camera, 1246);
    expect(useCamera).toHaveBeenCalledWith(camera, 1246);
  });

  it("uses the load view size from the first view after loading", async () => {
    vi.stubGlobal("window", { innerWidth: 1920, innerHeight: 1080 });
    vi.spyOn(GPU, "estimateCapacity").mockReturnValue(1);
    const setup = vi
      .spyOn(FragmentsModel.prototype, "_setup")
      .mockResolvedValue(undefined);
    const fragments = new FragmentsModels("worker-url");
    fragments.settings.autoCoordinate = false;
    const fetch = vi
      .spyOn((fragments as any)._connection, "fetch")
      .mockResolvedValue({});
    const camera = new THREE.PerspectiveCamera();
    const bytes = new Uint8Array([1]);

    await fragments.load(bytes, { modelId: "model", camera, viewSize: 1246 });

    const views = fetch.mock.calls
      .map(([request]: any[]) => request)
      .filter(
        ({ class: type }) => type === MultiThreadingRequestClass.REFRESH_VIEW,
      );
    expect(views).toHaveLength(1);
    expect(views[0].view.viewSize).toBe(1246);

    // An invalid size is rejected before the model is set up or registered.
    setup.mockClear();
    await expect(
      fragments.load(bytes, { modelId: "invalid", camera, viewSize: 0 }),
    ).rejects.toThrow("viewSize");
    expect(fragments.models.list.has("invalid")).toBe(false);
    expect(setup).not.toHaveBeenCalled();
  });

  it("installs the dense item identity map during setup", async () => {
    const fragments = new FragmentsModels("worker-url");
    const invoke = vi.fn(async () => {
      throw new Error("identity lookup must not invoke the worker");
    });
    const itemLocalIds = new Uint32Array([0, 0xffffffff, 0xffffffff, 42]);
    const fetch = vi.fn(async () => ({
      boundingBox: new THREE.Box3(
        new THREE.Vector3(-1, -2, -3),
        new THREE.Vector3(4, 5, 6),
      ),
      itemLocalIds,
    }));
    const model = new FragmentsModel(
      "model-a",
      fragments.models,
      { fetch, invoke } as any,
      fragments.editor,
    );
    const setupManager = (model as any)._setupManager;

    await setupManager.setup(
      model,
      new THREE.Box3(),
      new Uint8Array([1]),
      true,
      {},
    );

    await expect(
      model.getLocalIdsFromItemIds([1, 0, 4, 1, 2, 3]),
    ).resolves.toEqual([0xffffffff, 0, 42]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not rearm rendering for a FINISH-only request", () => {
    const fragments = new FragmentsModels("worker-url");
    const renderUpdate = vi.spyOn(fragments, "update").mockResolvedValue();
    const model = {
      modelId: "model",
      _finishProcessing: vi.fn(),
      tiles: new Map(),
      visibleItems: new Set<number>(),
    } as unknown as FragmentsModel;
    fragments.models.list.set("model", model);

    fragments.models.requests.add([
      {
        modelId: "model",
        renderRevision: fragments.models.beginViewUpdate(model),
        tileRequestClass: TileRequestClass.FINISH,
      },
    ]);

    expect(renderUpdate).not.toHaveBeenCalled();
  });

  it("resolves draw chunks through reverse-indexed tiles", () => {
    const unrelatedItemLookup = vi.fn(() => {
      throw new Error("unrelated tiles must not be scanned");
    });
    const tileBySample: any[] = [];
    tileBySample[2] = 101;
    tileBySample[3] = [101, 102];
    const lodBySample: any[] = [];
    lodBySample[2] = 201;
    lodBySample[3] = 202;
    const context = {
      _boxes: { sampleOf: (itemId: number) => (itemId === 7 ? [2, 3] : []) },
      _lodBySample: lodBySample,
      _tileBySample: tileBySample,
      _tiles: new Map([
        [
          999,
          {
            notVirtual: true,
            indexCount: 3,
            indexLocation: [0],
            sampleSpans: new Map([[99, { start: 0, count: 1 }]]),
          },
        ],
        [
          101,
          {
            notVirtual: true,
            indexCount: 21,
            indexLocation: [0, 3, 9, 15],
            sampleSpans: new Map([
              [50, { start: 0, count: 1 }],
              [2, { start: 1, count: 1 }],
              [3, { start: 2, count: 1 }],
              [51, { start: 3, count: 1 }],
            ]),
          },
        ],
        [
          102,
          {
            notVirtual: true,
            indexCount: 12,
            indexLocation: [0, 6],
            sampleSpans: new Map([
              [40, { start: 0, count: 1 }],
              [3, { start: 1, count: 1 }],
            ]),
          },
        ],
        [
          201,
          {
            notVirtual: true,
            indexCount: 6,
            indexLocation: [0],
            sampleSpans: new Map([[2, { start: 0, count: 1 }]]),
          },
        ],
        [
          202,
          {
            notVirtual: false,
            indexCount: 6,
            indexLocation: [0],
            sampleSpans: new Map([[3, { start: 0, count: 1 }]]),
          },
        ],
      ]),
      itemId: unrelatedItemLookup,
    };

    const result = VirtualTilesController.prototype.getDrawChunksForItems.call(
      context as any,
      new Set([7]),
    );
    expect(
      result
        .map((chunk) => ({
          tileId: chunk.tileId,
          position: [...chunk.position],
          size: [...chunk.size],
        }))
        .sort((a, b) => a.tileId - b.tileId),
    ).toEqual([
      { tileId: 101, position: [3], size: [12] },
      { tileId: 102, position: [6], size: [6] },
      { tileId: 201, position: [0], size: [6] },
    ]);
    expect(unrelatedItemLookup).not.toHaveBeenCalled();
  });
});
