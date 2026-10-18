import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BufferGeometry,
  Frustum,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from "three";
import { Connection } from "../multithreading/connection";
import { FragmentsThread } from "../multithreading/fragments-thread";
import { MeshConnection } from "../multithreading/mesh-connection";
import { GPU, MultiBufferData } from "../utils";
import { VirtualFragmentsModel } from "../virtual-model/virtual-fragments-model";
import { VirtualTilesController } from "../virtual-model/virtual-controllers/virtual-tiles-controller";
import { FragmentsModel } from "./fragments-model";
import { MeshManager } from "./mesh-manager";
import {
  CurrentLod,
  MultiThreadingRequestClass,
  ObjectClass,
  TileRequestClass,
} from "./model-types";
import { ViewManager } from "./view-manager";

const cleanup: (() => void)[] = [];

function createProtocolHarness() {
  const meshes = new MeshManager(vi.fn());
  cleanup.push(() => meshes.dispose());
  const received: any[] = [];
  const connection = new Connection(async (request) => {
    if (request.list) received.push(...request.list);
    await meshes.requests.handleRequest(meshes, request);
  });
  const channel = new MessageChannel();
  const thread = new FragmentsThread();
  connection.init(channel.port1 as unknown as MessagePort);
  thread.useConnection(channel.port2 as unknown as MessagePort);
  cleanup.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  const dispatch = vi.spyOn(connection, "fetch");

  function addModel(modelId: string, sampleAmount = 100) {
    const geometry = new BufferGeometry();
    geometry.setIndex([0, 1, 2, 3, 4, 5]);
    geometry.addGroup(0, Infinity, 0);
    const material = new MeshBasicMaterial();
    const mesh = new Mesh(geometry, material);
    cleanup.push(() => {
      geometry.dispose();
      material.dispose();
    });
    const model = {
      modelId,
      object: new Group(),
      graphicsQuality: 1,
      threads: connection,
      tiles: new Map([[1, mesh]]),
      _finishProcessing: vi.fn(),
      _failProcessing: vi.fn(),
    } as unknown as FragmentsModel;
    meshes.list.set(modelId, model);

    const meshConnection = new MeshConnection(modelId, thread.connection, {
      meshConnectionRate: 60_000,
      meshConnectionThreshold: 0,
    });
    cleanup.push(() => meshConnection.dispose());
    const changedTiles = new Set<number>();
    const visibilities = new MultiBufferData(2, true);
    const processedSamples: number[] = [];
    // Keep only sample evaluation synthetic: view restart, sweep budgeting,
    // tile data construction, completion, and both wire directions stay real.
    const controller = Object.create(
      VirtualTilesController.prototype,
    ) as VirtualTilesController;
    Object.assign(controller, {
      _modelId: modelId,
      _sampleAmount: sampleAmount,
      _boxes: { lookup: null },
      _outsideMask: new Uint8Array(sampleAmount),
      _rewindArmed: true,
      _currentSample: 0,
      _changedSamples: 0,
      _samplesDimensions: Int32Array.from(
        { length: sampleAmount },
        (_, index) => index,
      ),
      _params: {
        updateTime: 16,
        updateSamples: 64,
        updateviewOrientation: (8 * Math.PI) / 180,
        updateViewPosition: 256,
      },
      _lastView: { rotation: new Vector3(), location: new Vector3() },
      _tiles: new Map([
        [
          1,
          {
            objectClass: ObjectClass.SHELL,
            materialId: 1,
            lod: CurrentLod.GEOMETRY,
            indexCount: 6,
            indexLocation: [0, 3],
            visibilities,
          },
        ],
      ]),
      _tilesChanged: changedTiles,
      _tilesToRebuild: new Set(),
      _meshConnection: meshConnection,
      tilesUpdated: false,
      updateMesh(sample: number) {
        processedSamples.push(sample);
        if (sample === 0) {
          visibilities.update(0, false);
          changedTiles.add(1);
        }
      },
    });
    const workerModel = Object.create(
      VirtualFragmentsModel.prototype,
    ) as VirtualFragmentsModel;
    Object.assign(workerModel, { tiles: controller });
    thread.list.set(modelId, workerModel);
    const view = new ViewManager();
    view.useCamera(new PerspectiveCamera(), 1000);

    return { model, workerModel, controller, view, geometry, processedSamples };
  }

  // An acknowledged empty batch follows preceding worker messages on the same
  // port, giving assertions a deterministic delivery boundary without sleeps.
  async function flushWorkerMessages() {
    await thread.connection.fetch({
      class: MultiThreadingRequestClass.RECOMPUTE_MESHES,
      modelId: "",
      list: [],
    });
  }

  const finishes = () =>
    received.filter(
      (request) => request.tileRequestClass === TileRequestClass.FINISH,
    );

  // Runs one tick of the worker's real update loop over every model and
  // reports whether the loop scheduled its next tick.
  function tickUpdater() {
    const { updater } = thread.controllerManager;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      updater.start();
      vi.advanceTimersToNextTimer();
      return vi.getTimerCount() === 1;
    } finally {
      updater.stop();
      vi.useRealTimers();
    }
  }

  return {
    meshes,
    connection,
    dispatch,
    received,
    addModel,
    flushWorkerMessages,
    finishes,
    tickUpdater,
  };
}

describe("view completion across the worker protocol", () => {
  beforeEach(() => {
    vi.spyOn(GPU, "estimateCapacity").mockReturnValue(200_000_000);
    vi.spyOn(performance, "now").mockReturnValue(100);
  });

  afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
    vi.restoreAllMocks();
  });

  it("retains each model's view revision across unrelated RPCs and out-of-order completion", async () => {
    const protocol = createProtocolHarness();
    const slow = protocol.addModel("slow");
    const fast = protocol.addModel("fast", 1);
    await slow.view.refreshView(slow.model, protocol.meshes);
    await fast.view.refreshView(fast.model, protocol.meshes);
    const sentSlow = protocol.dispatch.mock.calls[0][0].view;
    const sentFast = protocol.dispatch.mock.calls[1][0].view;
    expect(sentSlow.renderRevision).toBeGreaterThan(0);
    expect(sentFast.renderRevision).toBeGreaterThan(sentSlow.renderRevision);
    expect(slow.workerModel.view).not.toBe(sentSlow);
    expect(slow.workerModel.view.cameraFrustum).toBeInstanceOf(Frustum);
    expect(slow.workerModel.view.cameraPosition).toBeInstanceOf(Vector3);
    expect(slow.workerModel.view.renderRevision).toBe(sentSlow.renderRevision);
    expect(fast.workerModel.view.renderRevision).toBe(sentFast.renderRevision);

    Object.assign(slow.workerModel, { readFixtureValue: () => 42 });
    await protocol.connection.fetch({
      class: MultiThreadingRequestClass.EXECUTE,
      modelId: "slow",
      function: "readFixtureValue",
      parameters: [],
    });
    const resolved = vi.fn();
    const completion = protocol.meshes.forceUpdateFinish().then(resolved);
    await slow.controller.update(0);
    await fast.controller.update(0);
    await protocol.flushWorkerMessages();

    expect(slow.processedSamples).toHaveLength(64);
    expect(protocol.finishes()).toEqual([
      {
        tileRequestClass: TileRequestClass.FINISH,
        modelId: "fast",
        renderRevision: sentFast.renderRevision,
      },
    ]);
    await vi.waitFor(() =>
      expect(fast.model._finishProcessing).toHaveBeenCalledOnce(),
    );
    expect(slow.model._finishProcessing).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();

    await slow.controller.update(0);
    await protocol.flushWorkerMessages();
    await completion;

    expect(protocol.finishes()[1]).toEqual({
      tileRequestClass: TileRequestClass.FINISH,
      modelId: "slow",
      renderRevision: sentSlow.renderRevision,
    });
    expect(resolved).toHaveBeenCalledOnce();
  });

  it("applies a preceding tile UPDATE before the full-sweep fence resolves", async () => {
    const protocol = createProtocolHarness();
    const { model, controller, view, geometry } = protocol.addModel("model");
    const originalIndex = geometry.index;
    await view.refreshView(model, protocol.meshes);
    const resolvedGroups = vi.fn(() =>
      geometry.groups.map((group) => ({ ...group })),
    );
    const completion = protocol.meshes.forceUpdateFinish().then(resolvedGroups);

    await controller.update(0);
    await protocol.flushWorkerMessages();

    expect(protocol.finishes()).toEqual([]);
    expect(protocol.received).toHaveLength(1);
    expect(protocol.received[0].tileRequestClass).toBe(TileRequestClass.UPDATE);
    expect(protocol.received[0].tileData.visibilityData.position).toEqual(
      new Uint32Array([3]),
    );
    // Arrivals are applied without waiting for the worker's final sweep.
    await vi.waitFor(() =>
      expect(geometry.groups).toEqual([
        { start: 3, count: Infinity, materialIndex: 0 },
      ]),
    );
    expect(resolvedGroups).not.toHaveBeenCalled();

    await controller.update(0);
    await protocol.flushWorkerMessages();
    const groupsAtCompletion = await completion;

    expect(groupsAtCompletion).toEqual([
      { start: 3, count: Infinity, materialIndex: 0 },
    ]);
    expect(geometry.index).toBe(originalIndex);
    expect(protocol.meshes.requests.arePending).toBe(false);
    expect(model._finishProcessing).toHaveBeenCalledOnce();
  });

  it("requires a complete new sweep when a view supersedes a partial sweep", async () => {
    const protocol = createProtocolHarness();
    const { model, workerModel, controller, view, processedSamples } =
      protocol.addModel("model");
    await view.refreshView(model, protocol.meshes);
    const firstRevision = workerModel.view.renderRevision;
    const resolved = vi.fn();
    const firstCompletion = protocol.meshes.forceUpdateFinish().then(resolved);
    await controller.update(0);
    await protocol.flushWorkerMessages();
    expect(processedSamples).toHaveLength(64);

    view.currentCamera!.position.x += 1;
    await view.refreshView(model, protocol.meshes);
    const replacementRevision = workerModel.view.renderRevision;
    expect(replacementRevision).toBeGreaterThan(firstRevision);
    const replacementCompletion = protocol.meshes
      .forceUpdateFinish()
      .then(resolved);
    processedSamples.length = 0;
    await controller.update(0);
    await protocol.flushWorkerMessages();

    expect(processedSamples).toHaveLength(64);
    expect(protocol.finishes()).toEqual([]);
    expect(resolved).not.toHaveBeenCalled();

    await controller.update(0);
    await protocol.flushWorkerMessages();
    await Promise.all([firstCompletion, replacementCompletion]);

    expect(new Set(processedSamples).size).toBe(100);
    expect(processedSamples).toHaveLength(100);
    expect(protocol.finishes()).toEqual([
      {
        tileRequestClass: TileRequestClass.FINISH,
        modelId: "model",
        renderRevision: replacementRevision,
      },
    ]);
    expect(resolved).toHaveBeenCalledTimes(2);
    expect(model._finishProcessing).toHaveBeenCalledOnce();
  });

  it("rejects only the view of a model whose update throws and recovers on its next sweep", async () => {
    const protocol = createProtocolHarness();
    const broken = protocol.addModel("broken");
    const healthy = protocol.addModel("healthy");
    const sampleUpdate = (broken.controller as any).updateMesh;
    const failure = new Error("fixture sample failed");
    (broken.controller as any).updateMesh = () => {
      throw failure;
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await healthy.view.refreshView(healthy.model, protocol.meshes);
    const healthyOnly = protocol.meshes.forceUpdateFinish();
    await broken.view.refreshView(broken.model, protocol.meshes);
    const failedRevision = broken.workerModel.view.renderRevision;
    const everyModel = expect(
      protocol.meshes.forceUpdateFinish(),
    ).rejects.toThrow(/model broken: Error: fixture sample failed/);

    expect(protocol.tickUpdater()).toBe(true);
    await protocol.flushWorkerMessages();
    await Promise.all([healthyOnly, everyModel]);

    expect(protocol.finishes()).toEqual([
      {
        tileRequestClass: TileRequestClass.FINISH,
        modelId: "broken",
        renderRevision: failedRevision,
        error: "Error: fixture sample failed",
      },
      {
        tileRequestClass: TileRequestClass.FINISH,
        modelId: "healthy",
        renderRevision: healthy.workerModel.view.renderRevision,
      },
    ]);
    expect(broken.model._finishProcessing).not.toHaveBeenCalled();
    expect(broken.model._failProcessing).toHaveBeenCalledOnce();
    expect(healthy.model._failProcessing).not.toHaveBeenCalled();
    expect(healthy.model._finishProcessing).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledExactlyOnceWith(failure);

    // A failed sweep stays stopped until a new view restarts it.
    expect(protocol.tickUpdater()).toBe(true);
    await protocol.flushWorkerMessages();
    expect(protocol.finishes()).toHaveLength(2);

    (broken.controller as any).updateMesh = sampleUpdate;
    await broken.view.refreshView(broken.model, protocol.meshes, true);
    const recovered = protocol.meshes.forceUpdateFinish();
    expect(protocol.tickUpdater()).toBe(true);
    await protocol.flushWorkerMessages();
    await recovered;

    expect(protocol.finishes()[2]).toEqual({
      tileRequestClass: TileRequestClass.FINISH,
      modelId: "broken",
      renderRevision: broken.workerModel.view.renderRevision,
    });
    expect(broken.model._finishProcessing).toHaveBeenCalledOnce();
  });
});
