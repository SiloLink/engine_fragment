import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Box3, Matrix4, Vector3 } from "three";
import {
  CurrentLod,
  ObjectClass,
  TileRequestClass,
} from "../../model/model-types";
import { MultithreadingHelper } from "../../multithreading/multithreading-helper";
import { MultiBufferData } from "../../utils/misc/multi-buffer-data";
import { ItemConfigController } from "./item-config-controller";
import { VirtualTilesController } from "./virtual-tiles-controller";

const graphicsMemory = VirtualTilesController as any;

function createShell() {
  return {
    objectClass: ObjectClass.SHELL,
    materialId: 1,
    indexCount: 6,
    positionCount: 12,
    normalCount: 12,
    indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    positionBuffer: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normalBuffer: new Int16Array([
      0, 0, 32767, 0, 0, 32767, 0, 0, 32767, 0, 0, 32767,
    ]),
    faceIdBuffer: new Uint32Array([10, 20, 30, 40]),
    renderLayout: {
      indices: new Uint16Array([2, 0, 3, 2, 3, 1]),
      oldToNewVertex: new Uint16Array([2, 0, 3, 1]),
    },
  };
}

function shellPayloadBytes(request: any) {
  return [
    request.positions,
    request.normals,
    request.indices,
    request.itemIds,
    request.faceIds,
  ].reduce((total, attribute) => total + attribute.byteLength, 0);
}

function createModel(modelId: string) {
  const controller = Object.create(VirtualTilesController.prototype) as any;
  const shell = createShell();
  const posted: any[] = [];
  const sentPositions: Float32Array[] = [];
  const samples = new ItemConfigController(4);
  const fetchSample = vi.fn((sample: number) => ({
    sample,
    geometries: shell,
    transform: new Matrix4(),
  }));
  Object.assign(controller, {
    _modelId: modelId,
    _temp: { vector: new Vector3(), matrix: new Matrix4() },
    _boxes: {
      get: () => new Box3(new Vector3(), new Vector3(1, 1, 0)),
    },
    _materialController: {
      shouldUseOptimizedLayout: (_material: number, highlight: number) =>
        highlight !== 9,
    },
    _samples: samples,
    _virtualView: { graphicThreshold: Infinity },
    _virtualMeshes: new Map(),
    _tiles: new Map(),
    _tilesChanged: new Set(),
    _meshConnection: {
      process(request: any) {
        if (request.positions) sentPositions.push(request.positions);
        const transfer = MultithreadingHelper.getRequestContent({
          list: [request],
        });
        posted.push(structuredClone(request, { transfer }));
      },
      dispose() {},
    },
    fetchSample,
    itemId: (sample: number) => sample,
  });

  function addTile(tileId: number, sample = 0) {
    const tile = controller.newTile(ObjectClass.SHELL, 1, CurrentLod.GEOMETRY);
    controller.tileAppend(tile, shell, sample, 0);
    tile.visibilities = new MultiBufferData<boolean>(tile.size, false);
    tile.highlights = new MultiBufferData<number>(tile.size, 0);
    controller._tiles.set(tileId, tile);
    return tile;
  }

  function realize(tileId: number, sample = 0) {
    controller.updateTile(tileId, sample, 0, true);
  }

  return {
    controller,
    samples,
    addTile,
    realize,
    posted,
    sentPositions,
    fetchSample,
  };
}

describe("resident tile memory", () => {
  let previousMemory: number;

  beforeEach(() => {
    previousMemory = graphicsMemory._graphicMemoryConsumed;
    graphicsMemory._graphicMemoryConsumed = 0;
  });

  afterEach(() => {
    graphicsMemory._graphicMemoryConsumed = previousMemory;
  });

  it("credits the SHELL CREATE attributes before their buffers are transferred", () => {
    const model = createModel("first");
    const tile = model.addTile(1);
    expect(graphicsMemory._graphicMemoryConsumed).toBe(0);

    model.realize(1);

    const create = model.posted[0];
    expect(create.tileRequestClass).toBe(TileRequestClass.CREATE);
    expect(model.sentPositions[0].byteLength).toBe(0);
    expect(create.positions.byteLength).toBe(48);
    expect(tile.usedMemory).toBe(shellPayloadBytes(create));
    expect(graphicsMemory._graphicMemoryConsumed).toBe(
      shellPayloadBytes(create),
    );
  });

  it("releases only its resident tiles once when another model shares the worker", () => {
    const first = createModel("first");
    const second = createModel("second");
    first.addTile(1);
    first.addTile(2, 1);
    const secondTile = second.addTile(1);
    first.realize(1);
    second.realize(1);

    first.controller.dispose();
    expect(graphicsMemory._graphicMemoryConsumed).toBe(secondTile.usedMemory);
    expect(secondTile.notVirtual).toBe(true);

    first.controller.dispose();
    expect(graphicsMemory._graphicMemoryConsumed).toBe(secondTile.usedMemory);

    second.controller.dispose();
    expect(graphicsMemory._graphicMemoryConsumed).toBe(0);
  });

  it("releases evicted geometry and restores its credit when shown again", () => {
    const first = createModel("first");
    const second = createModel("second");
    const firstTile = first.addTile(1);
    const secondTile = second.addTile(1);
    first.realize(1);
    second.realize(1);
    const before = graphicsMemory._graphicMemoryConsumed;
    first.controller._virtualView.graphicThreshold = 0;

    first.controller.makeInvisibleFromTile(1, 0);
    expect(firstTile.notVirtual).toBe(false);
    expect(graphicsMemory._graphicMemoryConsumed).toBe(secondTile.usedMemory);

    first.realize(1);
    expect(graphicsMemory._graphicMemoryConsumed).toBe(before);
    expect(first.posted.map((request) => request.tileRequestClass)).toEqual([
      TileRequestClass.CREATE,
      TileRequestClass.DELETE,
      TileRequestClass.CREATE,
    ]);
  });

  it("keeps resident attributes and memory credit when opacity changes index order", () => {
    const model = createModel("first");
    model.addTile(1);
    model.realize(1);
    const before = graphicsMemory._graphicMemoryConsumed;
    model.samples.setHighlight(0, 9);

    model.controller.updateTile(1, 0, 9, false);
    model.controller.update(0);

    expect(graphicsMemory._graphicMemoryConsumed).toBe(before);
    expect(model.posted.map((request) => request.tileRequestClass)).toEqual([
      TileRequestClass.CREATE,
      TileRequestClass.UPDATE,
    ]);
    expect(model.posted[1].indexUpdates[0].indices.byteLength).toBe(12);
    expect(model.sentPositions).toHaveLength(1);
    expect(
      model.sentPositions.every((positions) => positions.byteLength === 0),
    ).toBe(true);
  });

  it("retains resident geometry if preparing an index update fails", () => {
    const first = createModel("first");
    const second = createModel("second");
    const firstTile = first.addTile(1);
    const secondTile = second.addTile(1);
    first.realize(1);
    second.realize(1);
    first.samples.setHighlight(0, 9);
    first.fetchSample.mockImplementationOnce(() => {
      throw new Error("Unable to construct fixture shell");
    });

    expect(() => first.controller.updateTile(1, 0, 9, false)).toThrow(
      "Unable to construct fixture shell",
    );
    expect(firstTile.notVirtual).toBe(true);
    expect(graphicsMemory._graphicMemoryConsumed).toBe(
      firstTile.usedMemory + secondTile.usedMemory,
    );
    expect(first.posted).toHaveLength(1);
    first.controller.dispose();
    expect(graphicsMemory._graphicMemoryConsumed).toBe(secondTile.usedMemory);
  });
});
