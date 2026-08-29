import { describe, expect, it, vi } from "vitest";
import { Box3, Matrix4, Vector3 } from "three";
import { CurrentLod, ObjectClass } from "../../model/model-types";
import { MultiBufferData } from "../../utils";
import { VirtualTilesController } from "../virtual-controllers/virtual-tiles-controller";

function createGeometry(offset: number) {
  return {
    objectClass: ObjectClass.LINE,
    materialId: 1,
    indexCount: 3,
    positionCount: 9,
    normalCount: 0,
    indexBuffer: new Uint16Array([0, 1, 2]),
    positionBuffer: new Float32Array([
      offset,
      0,
      0,
      offset + 1,
      0,
      0,
      offset,
      1,
      0,
    ]),
  };
}

function createTileHarness() {
  const first = createGeometry(1);
  const second = createGeometry(10);
  const adjacent = createGeometry(20);
  const controller = Object.create(VirtualTilesController.prototype) as any;

  controller._temp = {
    vector: new Vector3(),
    matrix: new Matrix4(),
  };
  controller._boxes = {
    get: vi.fn(() => new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 0))),
  };
  controller.fetchSample = vi.fn((sample: number) => ({
    sample,
    geometries: sample === 7 ? [first, second] : [adjacent],
    transform: new Matrix4(),
  }));

  const tile = {
    box: new Box3(),
    objectClass: ObjectClass.LINE,
    materialId: 1,
    lod: CurrentLod.GEOMETRY,
    indexCount: 0,
    positionCount: 0,
    normalCount: 0,
    indexLocation: [] as number[],
    vertexLocation: [] as number[],
    geometriesLocation: [] as number[],
    sampleSpans: new Map(),
    size: 0,
    notVirtual: false,
  };

  controller.tileAppend(tile, first, 7, 0);
  controller.tileAppend(tile, second, 7, 1);
  controller.tileAppend(tile, adjacent, 8, 0);

  return { controller, tile };
}

describe("tile sample spans", () => {
  it("realizes and updates every chunk owned by one sample", () => {
    const { controller, tile } = createTileHarness();

    expect(tile.sampleSpans.get(7)).toEqual({ start: 0, count: 2 });
    expect(tile.sampleSpans.get(8)).toEqual({ start: 2, count: 1 });

    tile.visibilities = new MultiBufferData<boolean>(tile.size, false);
    tile.highlights = new MultiBufferData<number>(tile.size, 0);
    controller.constructTile(tile);

    expect(controller._boxes.get).toHaveBeenCalledTimes(2);
    expect([...tile.indexBuffer]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect([
      tile.positionBuffer[0],
      tile.positionBuffer[9],
      tile.positionBuffer[18],
    ]).toEqual([0, 9, 19]);

    controller.updateTileData(tile, 7, true, 4);

    const visibility = MultiBufferData.get(
      tile.visibilities,
      tile.indexLocation,
      (value: boolean) => value,
    );
    const highlight = MultiBufferData.get(
      tile.highlights,
      tile.indexLocation,
      (value: number) => value === 4,
    );
    expect({
      position: [...visibility.position],
      size: [...visibility.size],
    }).toEqual({ position: [0], size: [6] });
    expect({
      position: [...highlight.position],
      size: [...highlight.size],
    }).toEqual({ position: [0], size: [6] });
  });

  it("returns every selected chunk without crossing the adjacent sample", () => {
    const { controller, tile } = createTileHarness();
    tile.notVirtual = true;
    controller._boxes.sampleOf = (item: number) => {
      if (item === 70) return [7];
      if (item === 80) return [8];
      return undefined;
    };
    controller._tileBySample = [];
    controller._tileBySample[7] = 101;
    controller._tileBySample[8] = 101;
    controller._lodBySample = [];
    controller._tiles = new Map([[101, tile]]);

    const selected = controller.getDrawChunksForItems(new Set([70]));
    expect(
      selected.map((chunk: any) => ({
        tileId: chunk.tileId,
        position: [...chunk.position],
        size: [...chunk.size],
      })),
    ).toEqual([{ tileId: 101, position: [0], size: [6] }]);

    const adjacentSelected = controller.getDrawChunksForItems(
      new Set([70, 80]),
    );
    expect(
      adjacentSelected.map((chunk: any) => ({
        tileId: chunk.tileId,
        position: [...chunk.position],
        size: [...chunk.size],
      })),
    ).toEqual([{ tileId: 101, position: [0], size: [9] }]);
  });
});
