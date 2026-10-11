import { Frustum, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TileRequestClass } from "../../model/model-types";
import { VirtualTilesController } from "./virtual-tiles-controller";

function createSweepHarness(sampleAmount = 100, currentSample = 0) {
  const controller = Object.create(VirtualTilesController.prototype) as any;
  const updateMesh = vi.fn<(sample: number) => void>();
  const process = vi.fn();
  const sampleIds = Array.from({ length: sampleAmount }, (_, index) => index);
  const cameraFrustum = new Frustum();
  const view = { cameraFrustum, cameraPosition: new Vector3() };

  Object.assign(controller, {
    _modelId: "sweep-fixture",
    _sampleAmount: sampleAmount,
    _boxes: { lookup: null },
    _outsideMask: new Uint8Array(sampleAmount),
    _rewindArmed: true,
    _currentSample: currentSample,
    _changedSamples: 0,
    _samplesDimensions: Int32Array.from(sampleIds),
    _virtualView: view,
    _params: {
      updateTime: 16,
      updateSamples: 64,
      updateviewOrientation: (8 * Math.PI) / 180,
      updateViewPosition: 256,
    },
    _lastView: {
      rotation: cameraFrustum.planes[4].normal.clone(),
      location: new Vector3(),
    },
    _tilesChanged: new Set(),
    _tilesToRebuild: new Set(),
    _meshConnection: { process, clean: vi.fn() },
    tilesUpdated: false,
    updateMesh,
  });

  const processedSamples = () =>
    updateMesh.mock.calls.map(([sample]) => sample);
  return { controller, updateMesh, process, sampleIds, view, processedSamples };
}

describe("virtual tile view sweeps", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(100);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([0, 100])(
    "finishes only the remaining samples on a continuation starting at %i ms",
    async (continuationTime) => {
      const { controller, process, sampleIds, processedSamples } =
        createSweepHarness();

      await controller.update(0);

      expect(processedSamples()).toEqual(sampleIds.slice(0, 64));
      expect(process).not.toHaveBeenCalled();
      expect(controller.tilesUpdated).toBe(false);

      await controller.update(continuationTime);

      expect(processedSamples()).toEqual(sampleIds);
      expect(process).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ tileRequestClass: TileRequestClass.FINISH }),
      );
      expect(controller.tilesUpdated).toBe(true);

      await controller.update(100);

      expect(processedSamples()).toEqual(sampleIds);
      expect(process).toHaveBeenCalledOnce();
    },
  );

  it("visits each sample once when a sweep wraps around the sample order", async () => {
    const { controller, sampleIds, processedSamples } = createSweepHarness(
      100,
      80,
    );
    const expected = [...sampleIds.slice(80), ...sampleIds.slice(0, 80)];

    await controller.update(0);
    expect(processedSamples()).toEqual(expected.slice(0, 64));

    await controller.update(0);
    expect(processedSamples()).toEqual(expected);
  });

  it.each([0, 32])(
    "continues identical views and restarts changed views (displacement %i)",
    async (displacement) => {
      const { controller, updateMesh, sampleIds, view, processedSamples } =
        createSweepHarness();

      await controller.update(0);
      updateMesh.mockClear();
      controller.setupView({
        ...view,
        cameraPosition: new Vector3(displacement, 0, 0),
      });
      const expected = displacement === 0 ? sampleIds.slice(64) : sampleIds;

      await controller.update(0);
      expect(processedSamples()).toEqual(expected.slice(0, 64));

      await controller.update(0);
      expect(processedSamples()).toEqual(expected);
      expect(controller.tilesUpdated).toBe(true);
    },
  );

  it("settles an empty model without evaluating a sample", async () => {
    const { controller, updateMesh, process } = createSweepHarness(0);

    await controller.update(0);
    await controller.update(0);

    expect(updateMesh).not.toHaveBeenCalled();
    expect(process).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tileRequestClass: TileRequestClass.FINISH }),
    );
    expect(controller.tilesUpdated).toBe(true);
  });

  it.each([0, 100])(
    "waits for a view before evaluating %i samples",
    async (samples) => {
      const { controller, updateMesh, process } = createSweepHarness(samples);
      controller._virtualView = undefined;

      await controller.update(0);

      expect(updateMesh).not.toHaveBeenCalled();
      expect(process).not.toHaveBeenCalled();
      expect(controller.tilesUpdated).toBe(false);
    },
  );
});
