import { describe, expect, it, vi } from "vitest";
import { Box3, Matrix4, Vector3 } from "three";
import {
  CurrentLod,
  ObjectClass,
  TileRequestClass,
} from "../../model/model-types";
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

function createRenderLayoutHarness(opaque: boolean) {
  const canonical = {
    objectClass: ObjectClass.SHELL,
    materialId: 3,
    indexCount: 6,
    positionCount: 12,
    normalCount: 12,
    indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    positionBuffer: new Float32Array([1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0]),
    normalBuffer: new Int16Array([
      32767, 0, 0, 0, 32767, 0, 0, 0, 32767, -32767, 0, 0,
    ]),
    faceIdBuffer: new Uint32Array([10, 20, 30, 40]),
    renderLayout: {
      indices: new Uint16Array([2, 0, 3, 2, 3, 1]),
      oldToNewVertex: new Uint16Array([2, 0, 3, 1]),
    },
  };
  const controller = Object.create(VirtualTilesController.prototype) as any;
  const transform = new Matrix4().makeTranslation(10, 5, 0);

  controller._temp = {
    vector: new Vector3(),
    matrix: new Matrix4(),
  };
  let highlight = 0;
  controller._materialController = {
    isOpaque: vi.fn((_material: number, highlightId = 0) =>
      highlightId === 9 ? false : opaque,
    ),
  };
  controller._samples = {
    getHighlight: vi.fn(() => highlight),
    setHighlight: vi.fn((_sample: number, value: number) => {
      highlight = value;
    }),
    setVisible: vi.fn(),
  };
  controller._boxes = {
    get: vi.fn(() => new Box3(new Vector3(10, 5, 0), new Vector3(12, 6, 0))),
  };
  controller.fetchSample = vi.fn(() => ({
    sample: 7,
    geometries: canonical,
    transform,
  }));
  controller.itemId = vi.fn(() => 0x12345677);

  const tile = {
    box: new Box3(),
    objectClass: ObjectClass.SHELL,
    materialId: 3,
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
  controller.tileAppend(tile, canonical, 7, 0);
  tile.visibilities = new MultiBufferData<boolean>(tile.size, false);
  tile.highlights = new MultiBufferData<number>(tile.size, 0);

  return { canonical, controller, tile };
}

describe("tile sample spans", () => {
  it("applies an opaque SHELL render layout without changing canonical geometry or tile ranges", () => {
    const { canonical, controller, tile } = createRenderLayoutHarness(true);
    const canonicalSnapshot = {
      indices: canonical.indexBuffer.slice(),
      positions: canonical.positionBuffer.slice(),
      normals: canonical.normalBuffer.slice(),
      faceIds: canonical.faceIdBuffer.slice(),
    };
    const rangeSnapshot = {
      indexCount: tile.indexCount,
      positionCount: tile.positionCount,
      sampleSpans: [...tile.sampleSpans],
      geometriesLocation: [...tile.geometriesLocation],
      indexLocation: [...tile.indexLocation],
      vertexLocation: [...tile.vertexLocation],
    };

    controller.constructTile(tile);

    expect(tile.location.toArray()).toEqual([11, 5, 0]);
    expect([...tile.indexBuffer]).toEqual([2, 0, 3, 2, 3, 1]);
    expect([...tile.positionBuffer]).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0,
    ]);
    expect([...tile.normalBuffer]).toEqual([
      0, 32767, 0, -32767, 0, 0, 32767, 0, 0, 0, 0, 32767,
    ]);
    expect([...tile.faceIdBuffer]).toEqual([720, 740, 710, 730]);
    expect([...tile.ids]).toEqual([
      0x12, 0x34, 0x56, 0x78, 0x12, 0x34, 0x56, 0x78, 0x12, 0x34, 0x56, 0x78,
      0x12, 0x34, 0x56, 0x78,
    ]);
    expect({
      indexCount: tile.indexCount,
      positionCount: tile.positionCount,
      sampleSpans: [...tile.sampleSpans],
      geometriesLocation: [...tile.geometriesLocation],
      indexLocation: [...tile.indexLocation],
      vertexLocation: [...tile.vertexLocation],
    }).toEqual(rangeSnapshot);
    expect(canonical.indexBuffer).toEqual(canonicalSnapshot.indices);
    expect(canonical.positionBuffer).toEqual(canonicalSnapshot.positions);
    expect(canonical.normalBuffer).toEqual(canonicalSnapshot.normals);
    expect(canonical.faceIdBuffer).toEqual(canonicalSnapshot.faceIds);
  });

  it("keeps canonical triangle and vertex order for translucent SHELL tiles", () => {
    const { controller, tile } = createRenderLayoutHarness(false);

    controller.constructTile(tile);

    expect([...tile.indexBuffer]).toEqual([0, 1, 2, 0, 2, 3]);
    expect([...tile.positionBuffer]).toEqual([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]);
    expect([...tile.faceIdBuffer]).toEqual([710, 720, 730, 740]);
  });

  it("re-realizes an existing tile when a highlight crosses the opacity boundary", () => {
    const { controller, tile } = createRenderLayoutHarness(true);
    const process = vi.fn();
    controller._meshConnection = { process };
    controller._modelId = "model";
    controller._tiles = new Map([[101, tile]]);
    controller._tileBySample = [];
    controller._tileBySample[7] = 101;
    controller._lodBySample = [];
    controller._tilesChanged = new Set();
    controller._tilesToRebuild = new Set();
    controller._virtualView = undefined;
    controller._sampleAmount = 1;
    controller._changedSamples = 0;
    controller.tilesUpdated = false;

    controller.buildNewVirtualTile(tile, 101);
    expect([...process.mock.calls[0][0].indices]).toEqual([2, 0, 3, 2, 3, 1]);
    process.mockClear();

    controller.setSample(7, true, 9, CurrentLod.GEOMETRY);
    controller.update(0);

    expect(
      process.mock.calls.map(([request]: any[]) => request.tileRequestClass),
    ).toEqual([TileRequestClass.DELETE, TileRequestClass.CREATE]);
    expect([...process.mock.calls[1][0].indices]).toEqual([0, 1, 2, 0, 2, 3]);

    process.mockClear();
    controller.setSample(7, true, 0, CurrentLod.GEOMETRY);
    controller.update(0);

    expect(
      process.mock.calls.map(([request]: any[]) => request.tileRequestClass),
    ).toEqual([TileRequestClass.DELETE, TileRequestClass.CREATE]);
    expect([...process.mock.calls[1][0].indices]).toEqual([2, 0, 3, 2, 3, 1]);
  });

  it("keeps same-opacity highlight changes on the lightweight update path", () => {
    const { controller, tile } = createRenderLayoutHarness(true);
    const process = vi.fn();
    controller._meshConnection = { process };
    controller._modelId = "model";
    controller._tiles = new Map([[101, tile]]);
    controller._tileBySample = [];
    controller._tileBySample[7] = 101;
    controller._lodBySample = [];
    controller._tilesChanged = new Set();
    controller._tilesToRebuild = new Set();
    controller._virtualView = undefined;
    controller._sampleAmount = 1;
    controller._changedSamples = 0;
    controller.tilesUpdated = false;

    controller.buildNewVirtualTile(tile, 101);
    process.mockClear();
    controller.setSample(7, true, 8, CurrentLod.GEOMETRY);
    controller.update(0);

    expect(
      process.mock.calls.map(([request]: any[]) => request.tileRequestClass),
    ).toEqual([TileRequestClass.UPDATE]);
  });

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
