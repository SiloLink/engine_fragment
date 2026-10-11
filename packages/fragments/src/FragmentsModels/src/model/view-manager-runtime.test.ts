import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshViewRequest, RenderView } from "../multithreading/protocol";
import { GPU } from "../utils";
import { VirtualTilesController } from "../virtual-model/virtual-controllers/virtual-tiles-controller";
import { FragmentsModel } from "./fragments-model";
import { MeshManager } from "./mesh-manager";
import { CurrentLod, LodMode } from "./model-types";
import { ViewManager } from "./view-manager";

function createViewHarness() {
  const fetch = vi
    .fn<(request: RefreshViewRequest) => Promise<void>>()
    .mockResolvedValue(undefined);
  const model = {
    modelId: "camera-fixture",
    object: new THREE.Group(),
    graphicsQuality: 2 / 3,
    threads: { fetch, activeThreadCount: 1 },
  } as unknown as FragmentsModel;
  const meshes = new MeshManager(vi.fn());
  const manager = new ViewManager();

  async function refresh() {
    await manager.refreshView(model, meshes);
    return fetch.mock.lastCall![0].view;
  }

  return { manager, model, refresh };
}

// Keep the real worker projection, clipping and LOD decisions; only model data
// is synthetic so the regression does not need a particular .frag asset.
function createLodHarness() {
  const box = new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(0, 0, -10),
    new THREE.Vector3().setScalar(0.5 / Math.sqrt(3)),
  );
  const visible = vi.fn(() => true);
  const pinned = new Set<number>();
  const controller = Object.create(VirtualTilesController.prototype) as any;
  Object.assign(controller, {
    meshes: { samples() {} },
    _temp: { sample: { item: () => 0 } },
    _items: { visible },
    _boxes: { get: () => box, dimensionOf: () => 0.5 },
    _geometryPinnedItems: pinned,
    _outsideMask: new Uint8Array(1),
    _lodMode: LodMode.DEFAULT,
    _sampleLodSize: [0.5],
    _params: {
      smallObjectSize: 2,
      smallScreenSize: 2,
      mediumScreenSize: 4,
      largeScreenSize: 16,
    },
  });

  function evaluate(view: RenderView) {
    controller._virtualView = view;
    controller.setupViewPlanes();
    return controller.fetchLodLevel(0) as CurrentLod;
  }

  return { evaluate, visible, pinned };
}

describe("ViewManager orthographic LOD", () => {
  beforeEach(() => {
    vi.spyOn(GPU, "estimateCapacity").mockReturnValue(200_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "landscape",
      bounds: [-80, 80, 40, -40],
      viewport: [1600, 800],
      span: 80,
    },
    {
      name: "portrait",
      bounds: [-40, 40, 80, -80],
      viewport: [800, 1600],
      span: 80,
    },
    {
      name: "asymmetric",
      bounds: [-25, 95, 45, -15],
      viewport: [1200, 600],
      span: 60,
    },
  ])(
    "matches the projected pixel scale of a $name camera",
    async ({ bounds, viewport, span }) => {
      const { manager, refresh } = createViewHarness();
      const camera = new THREE.OrthographicCamera(
        bounds[0],
        bounds[1],
        bounds[2],
        bounds[3],
      );
      camera.zoom = 2;
      manager.useCamera(camera, Math.max(...viewport));

      const view = await refresh();
      expect(view.orthogonalDimension).toBeCloseTo(span);
      expect(view.fov).toBeUndefined();

      // Compare against Three's actual projection of a one-unit displacement,
      // independently of the worker's span-to-pixel calculation.
      const origin = new THREE.Vector3(0, 0, -10).project(camera);
      const x = new THREE.Vector3(1, 0, -10).project(camera);
      const y = new THREE.Vector3(0, 1, -10).project(camera);
      const workerPixels = view.viewSize / view.orthogonalDimension!;
      expect(workerPixels).toBeCloseTo(((x.x - origin.x) * viewport[0]) / 2);
      expect(workerPixels).toBeCloseTo(((y.y - origin.y) * viewport[1]) / 2);
    },
  );

  it("updates LOD when zoom changes without rebinding the camera", async () => {
    const { manager, refresh } = createViewHarness();
    const { evaluate } = createLodHarness();
    const camera = new THREE.OrthographicCamera(-50, 50, 50, -50);
    manager.useCamera(camera, 1000);

    for (const [zoom, span, expectedLod] of [
      [0.1, 1000, CurrentLod.INVISIBLE],
      [1, 100, CurrentLod.WIRES],
      [10, 10, CurrentLod.GEOMETRY],
    ]) {
      camera.zoom = zoom;
      const view = await refresh();
      expect(view.orthogonalDimension).toBeCloseTo(span);
      expect(evaluate(view)).toBe(expectedLod);
    }

    // Orthographic screen size is independent of distance from the camera.
    camera.position.z = 500;
    expect(evaluate(await refresh())).toBe(CurrentLod.GEOMETRY);
  });

  it("uses the effective span when the camera has a view offset", async () => {
    const { manager, refresh } = createViewHarness();
    const camera = new THREE.OrthographicCamera(-80, 80, 40, -40);
    camera.zoom = 2;
    camera.setViewOffset(1600, 800, 800, 0, 800, 400);
    manager.useCamera(camera, 800);

    expect((await refresh()).orthogonalDimension).toBeCloseTo(40);
    camera.clearViewOffset();
    expect((await refresh()).orthogonalDimension).toBeCloseTo(80);
  });

  it("converts the span to model coordinates for a scaled model", async () => {
    const { manager, model, refresh } = createViewHarness();
    const camera = new THREE.OrthographicCamera(-80, 80, 40, -40);
    camera.zoom = 2;
    model.object.scale.setScalar(4);
    model.object.updateMatrixWorld();
    manager.useCamera(camera, 1600);

    const view = await refresh();
    expect(view.orthogonalDimension).toBeCloseTo(20);
    // One model-space unit occupies the same pixels as four world-space units.
    expect(view.viewSize / view.orthogonalDimension!).toBeCloseTo(
      (4 * 1600) / 80,
    );
  });

  it("clears orthographic state when switching to perspective and back", async () => {
    const { manager, refresh } = createViewHarness();
    const ortho = new THREE.OrthographicCamera(-50, 50, 50, -50);
    const perspective = new THREE.PerspectiveCamera(65);
    manager.useCamera(ortho, 1000);
    expect((await refresh()).orthogonalDimension).toBeCloseTo(100);

    manager.useCamera(perspective, 1000);
    const perspectiveView = await refresh();
    expect(perspectiveView.orthogonalDimension).toBeUndefined();
    expect(perspectiveView.fov).toBe(65);

    ortho.zoom = 2;
    manager.useCamera(ortho, 1000);
    const orthoView = await refresh();
    expect(orthoView.orthogonalDimension).toBeCloseTo(50);
    expect(orthoView.fov).toBeUndefined();
  });

  it("keeps geometry pins subordinate to explicit visibility and clipping", async () => {
    const { manager, refresh } = createViewHarness();
    const { evaluate, visible, pinned } = createLodHarness();
    const camera = new THREE.OrthographicCamera(-500, 500, 500, -500);
    manager.useCamera(camera, 1000);
    expect(evaluate(await refresh())).toBe(CurrentLod.INVISIBLE);

    pinned.add(0);
    expect(evaluate(await refresh())).toBe(CurrentLod.GEOMETRY);

    visible.mockReturnValue(false);
    expect(evaluate(await refresh())).toBe(CurrentLod.INVISIBLE);

    visible.mockReturnValue(true);
    manager.getClippingPlanesEvent = () => [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -1),
    ];
    expect(evaluate(await refresh())).toBe(CurrentLod.INVISIBLE);
  });
});
