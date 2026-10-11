import { Box3, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";

import { CurrentLod, LodMode } from "../../model/model-types";
import { CameraUtils } from "../../utils";
import { VirtualFragmentsModel } from "../virtual-fragments-model";
import { VirtualTilesController } from "../virtual-controllers/virtual-tiles-controller";

function createTilesHarness() {
  const controller = Object.create(VirtualTilesController.prototype) as any;
  const visible = vi.fn(() => true);

  controller._outsideMask = new Uint8Array(1);
  controller._lodMode = LodMode.DEFAULT;
  controller._geometryPinnedItems = new Set<number>();
  controller._temp = {
    sample: {
      item: () => 17,
    },
  };
  controller.meshes = {
    samples: vi.fn(),
  };
  controller._boxes = {
    get: vi.fn(() => new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))),
    dimensionOf: vi.fn(() => 4),
  };
  controller._items = { visible };
  controller._virtualPlanes = [];
  controller._virtualView = {
    cameraPosition: new Vector3(0, 0, 10),
    graphicQuality: 1,
  };
  controller._params = {
    smallObjectSize: 2,
    smallScreenSize: 2,
    mediumScreenSize: 4,
    largeScreenSize: 16,
  };
  controller._sampleLodSize = new Float32Array([1]);
  controller.screenSize = vi.fn(() => 3);
  controller.updateVirtualMeshes = vi.fn();

  return { controller, visible };
}

describe("item geometry pin", () => {
  it("keeps only pinned items in geometry while retaining visibility culling", () => {
    const { controller, visible } = createTilesHarness();

    expect(controller.fetchLodLevel(0)).toBe(CurrentLod.WIRES);
    controller.screenSize.mockReturnValue(0.5);
    expect(controller.fetchLodLevel(0)).toBe(CurrentLod.INVISIBLE);

    controller.setItemsGeometryPinned([17], true);

    expect(controller.updateVirtualMeshes).toHaveBeenCalledWith([17]);
    expect(controller.fetchLodLevel(0)).toBe(CurrentLod.GEOMETRY);

    controller.screenSize.mockReturnValue(0.5);
    expect(controller.fetchLodLevel(0)).toBe(CurrentLod.GEOMETRY);

    visible.mockReturnValue(false);
    expect(controller.fetchLodLevel(0)).toBe(CurrentLod.INVISIBLE);
  });

  it("clears a pin so the item inherits model LOD again", () => {
    const { controller } = createTilesHarness();

    controller.setItemsGeometryPinned([17], true);
    controller.setItemsGeometryPinned([17], false);

    expect(controller.fetchLodLevel(0)).toBe(CurrentLod.WIRES);
    expect(controller.updateVirtualMeshes).toHaveBeenNthCalledWith(1, [17]);
    expect(controller.updateVirtualMeshes).toHaveBeenNthCalledWith(2, [17]);
  });

  it("retains clipping as a hard cull for pinned items", () => {
    const { controller } = createTilesHarness();
    const collides = vi.spyOn(CameraUtils, "collides").mockReturnValue(false);

    try {
      controller.setItemsGeometryPinned([17], true);

      expect(controller.fetchLodLevel(0)).toBe(CurrentLod.INVISIBLE);
    } finally {
      collides.mockRestore();
    }
  });

  it("skips unchanged and empty pin requests", () => {
    const { controller } = createTilesHarness();

    controller.setItemsGeometryPinned([], true);
    controller.setItemsGeometryPinned([17], false);
    controller.setItemsGeometryPinned([17], true);
    controller.setItemsGeometryPinned([17], true);

    expect(controller.updateVirtualMeshes).toHaveBeenCalledOnce();
    expect(controller.updateVirtualMeshes).toHaveBeenCalledWith([17]);
  });

  it("converts public local IDs before applying geometry pins", () => {
    const model = Object.create(VirtualFragmentsModel.prototype) as any;
    model.properties = {
      getItemIdsFromLocalIds: vi.fn(() => [17, 18]),
    };
    model.tiles = {
      setItemsGeometryPinned: vi.fn(),
    };

    model.setItemsGeometryPinned([101, 102], true);

    expect(model.properties.getItemIdsFromLocalIds).toHaveBeenCalledWith([
      101, 102,
    ]);
    expect(model.tiles.setItemsGeometryPinned).toHaveBeenCalledWith(
      [17, 18],
      true,
    );
  });
});
