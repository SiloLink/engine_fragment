import { afterEach, describe, expect, it } from "vitest";
import { Box3, Matrix4, Plane, Vector3 } from "three";
import {
  EditRequestType,
  EditUtils,
  RenderedFaces,
  RepresentationClass,
  ShellType,
  Stroke,
} from "../../../../index";
import type { EditRequest } from "../../../../index";
import { LodMode, TileRequestClass } from "../../model/model-types";
import { CameraUtils } from "../../utils/geometry/camera-utils";
import { VirtualFragmentsModel } from "../virtual-fragments-model";

// Two samples share the first material/tile; the remaining materials make
// distinct, equally sized tiles so cache order is observable in DELETEs.
const items = [100, 101, 102, 103, 104];

function createModelBytes() {
  const transform = {
    position: [0, 0, 0],
    xDirection: [1, 0, 0],
    yDirection: [0, 1, 0],
  };
  const requests: EditRequest[] = [
    ...[1, 2, 3, 4].map((localId) => ({
      type: EditRequestType.CREATE_MATERIAL as const,
      localId,
      data: {
        r: localId * 50,
        g: 255,
        b: 255,
        a: 1,
        renderedFaces: RenderedFaces.ONE,
        stroke: Stroke.DEFAULT,
      },
    })),
    {
      type: EditRequestType.CREATE_REPRESENTATION,
      localId: 10,
      data: {
        bbox: [0, 0, 0, 1, 1, 0],
        representationClass: RepresentationClass.SHELL,
        geometry: {
          points: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
            [0, 1, 0],
          ],
          profiles: new Map([
            [0, [0, 1, 2]],
            [1, [0, 2, 3]],
          ]),
          holes: new Map(),
          bigProfiles: new Map(),
          bigHoles: new Map(),
          type: ShellType.NONE,
          profilesFaceIds: [0, 0],
        },
      },
    },
    {
      type: EditRequestType.CREATE_LOCAL_TRANSFORM,
      localId: 20,
      data: transform,
    },
  ];
  items.forEach((item, index) => {
    requests.push(
      {
        type: EditRequestType.CREATE_ITEM,
        localId: item,
        data: { data: {}, category: "IFCBUILDINGELEMENTPROXY" },
      },
      {
        type: EditRequestType.CREATE_GLOBAL_TRANSFORM,
        localId: 200 + index,
        data: { ...transform, itemId: item },
      },
      {
        type: EditRequestType.CREATE_SAMPLE,
        localId: 300 + index,
        data: {
          item: 200 + index,
          material: Math.max(1, index),
          representation: 10,
          localTransform: 20,
        },
      },
    );
  });
  const data = EditUtils.getModelFromBuffer(
    EditUtils.newModel({ raw: true }),
    true,
  );
  return EditUtils.edit(data, requests, { raw: true }).model;
}

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dispose.splice(0)) cleanup();
});

async function setup() {
  const posted: any[] = [];
  const connection = {
    fetch: async () => undefined,
    fetchMeshCompute(_modelId: string, list: any[]) {
      posted.push(...list);
    },
  };
  const model = new VirtualFragmentsModel(
    `cache-${crypto.randomUUID()}`,
    createModelBytes() as any,
    connection as any,
    {
      multithreading: {
        meshConnectionRate: 60_000,
        meshConnectionThreshold: 0,
      },
    },
  );
  dispose.push(() => model.dispose());
  await model.setupData();
  model.setLodMode(LodMode.ALL_GEOMETRY);
  const view = {
    cameraFrustum: CameraUtils.containing(model.getFullBBox()),
    cameraPosition: new Vector3(0, 1, 10),
    fov: 60,
    viewSize: 1000,
    graphicQuality: 0.5,
    clippingPlanes: [],
    modelPlacement: new Matrix4(),
    meshThreshold: 1e9,
  };
  const sweep = () => {
    for (let tick = 0; tick < 20 && !model.tiles.tilesUpdated; tick++) {
      model.tiles.update(performance.now());
    }
    expect(model.tiles.tilesUpdated).toBe(true);
  };
  const records = () => [
    ...((model.tiles as any)._tiles as Map<number, any>).entries(),
  ];
  const tileFor = (localId: number) => {
    const [itemId] = model.properties.getItemIdsFromLocalIds([localId]);
    const [sample] = (model.tiles as any)._boxes.sampleOf(itemId);
    const id = (model.tiles as any)._tileBySample[sample] as number;
    return { id, tile: (model.tiles as any)._tiles.get(id) };
  };
  const bytes = (localId: number) =>
    (model.tiles as any).tileCacheBytes(tileFor(localId).tile) as number;
  const hide = (...localIds: number[]) => {
    model.setVisible(localIds, false);
    sweep();
  };
  const show = (...localIds: number[]) => {
    model.setVisible(localIds, true);
    sweep();
  };
  const requests = (kind: TileRequestClass) =>
    posted.filter((r) => r.tileRequestClass === kind);
  model.refreshView(view as any);
  sweep();
  return {
    model,
    posted,
    view,
    sweep,
    records,
    tileFor,
    bytes,
    hide,
    show,
    requests,
  };
}

describe("resident tile cache with a real virtual model", () => {
  it("retains hidden geometry even when the visible working set exceeds the budget", async () => {
    const f = await setup();
    const cost = f.bytes(102);
    f.model.tiles.setCacheBudget(cost);
    expect(f.records().filter(([, tile]) => tile.notVirtual).length).toBe(4);
    expect(
      f.records().reduce((sum, [, tile]) => sum + (tile.usedMemory ?? 0), 0),
    ).toBeGreaterThan(cost);
    const initialCreates = f.requests(TileRequestClass.CREATE).length;
    const fullSize = f.model.tiles.geometryCacheSize;

    f.hide(102);
    expect(f.tileFor(102).tile.notVirtual).toBe(true);
    expect(f.requests(TileRequestClass.DELETE)).toHaveLength(0);
    f.show(102);
    expect(f.requests(TileRequestClass.CREATE)).toHaveLength(initialCreates);
    expect(f.model.tiles.geometryCacheSize).toBe(fullSize);
    expect(
      f
        .requests(TileRequestClass.UPDATE)
        .some((r) => r.tileId === f.tileFor(102).id),
    ).toBe(true);
  });

  it("evicts by inactivity order and ignores passive updates", async () => {
    const f = await setup();
    f.model.tiles.setCacheBudget(f.bytes(102) * 2);
    f.hide(102);
    f.hide(103);
    f.hide(102);
    f.hide(104);
    expect(f.requests(TileRequestClass.DELETE).map((r) => r.tileId)).toEqual([
      f.tileFor(102).id,
    ]);
    expect(f.tileFor(103).tile.notVirtual).toBe(true);
    expect(f.tileFor(104).tile.notVirtual).toBe(true);
    expect((f.model.tiles as any)._cache.bytes).toBe(f.bytes(102) * 2);

    f.model.tiles.setCacheBudget(f.bytes(102));
    expect(f.requests(TileRequestClass.DELETE).map((r) => r.tileId)).toEqual([
      f.tileFor(102).id,
      f.tileFor(103).id,
    ]);
    expect(f.tileFor(104).tile.notVirtual).toBe(true);
  });

  it("keeps partial and highlighted tiles outside the inactive cache", async () => {
    const f = await setup();
    f.model.tiles.setCacheBudget(0);
    f.hide(100);
    expect(f.tileFor(101).tile.notVirtual).toBe(true);
    f.model.highlight([102], { color: "#ff0000", opacity: 1 });
    f.sweep();
    expect(f.tileFor(102).tile.visibilities.fullOf(false)).toBe(true);
    expect(f.tileFor(102).tile.highlights.fullOf(0)).toBe(false);
    f.model.tiles.setCacheBudget(0);
    expect(f.tileFor(102).tile.notVirtual).toBe(true);
    expect(f.requests(TileRequestClass.DELETE)).toHaveLength(0);

    f.hide(101);
    expect(f.tileFor(101).tile.notVirtual).toBe(false);
    expect(f.tileFor(102).tile.notVirtual).toBe(true);
  });

  it("reuses offscreen geometry on reentry without changing LOD or visibility", async () => {
    const f = await setup();
    f.model.tiles.setCacheBudget(f.model.tiles.geometryCacheSize);
    const creates = f.requests(TileRequestClass.CREATE).length;
    const outside = new Box3(
      new Vector3(100, 100, 100),
      new Vector3(101, 101, 101),
    );
    f.model.refreshView({
      ...f.view,
      cameraFrustum: CameraUtils.containing(outside),
    } as any);
    f.sweep();
    expect(
      f
        .records()
        .filter(([, t]) => t.notVirtual)
        .every(
          ([, t]) => t.visibilities.fullOf(false) && t.highlights.fullOf(0),
        ),
    ).toBe(true);
    expect(f.requests(TileRequestClass.DELETE)).toHaveLength(0);
    f.model.refreshView(f.view as any);
    f.sweep();
    expect(f.requests(TileRequestClass.CREATE)).toHaveLength(creates);
    expect(
      f
        .records()
        .filter(([, t]) => t.notVirtual)
        .every(([, t]) => !t.visibilities.fullOf(false)),
    ).toBe(true);
  });

  it("does not emit stale updates or duplicate deletes when evicted or disposed", async () => {
    const f = await setup();
    const id = f.tileFor(102).id;
    const fullSize = f.model.tiles.geometryCacheSize;
    f.model.tiles.setCacheBudget(f.bytes(102));
    f.model.setVisible([102], false); // UPDATE has not yet been serialized.
    f.model.tiles.setCacheBudget(0);
    f.sweep();
    const deletion = f.posted.findIndex(
      (r) => r.tileRequestClass === TileRequestClass.DELETE && r.tileId === id,
    );
    expect(deletion).toBeGreaterThan(-1);
    expect(
      f.posted
        .slice(deletion + 1)
        .some(
          (r) =>
            r.tileId === id && r.tileRequestClass === TileRequestClass.UPDATE,
        ),
    ).toBe(false);
    expect(f.model.tiles.geometryCacheSize).toBe(fullSize);
    const count = f.requests(TileRequestClass.DELETE).length;
    f.model.dispose();
    f.model.dispose();
    f.model.tiles.setCacheBudget(0);
    expect(f.requests(TileRequestClass.DELETE)).toHaveLength(count);
    expect((f.model.tiles as any)._cache.bytes).toBe(0);
  });

  it("does not let geometry pins override clipping or cache eviction", async () => {
    const f = await setup();
    f.model.tiles.setCacheBudget(f.model.tiles.geometryCacheSize);
    f.model.setItemsGeometryPinned(items, true);
    f.model.refreshView({
      ...f.view,
      clippingPlanes: [new Plane(new Vector3(0, 0, 1), -100)],
    } as any);
    f.sweep();
    const resident = f.records().filter(([, tile]) => tile.notVirtual);
    expect(resident).toHaveLength(4);
    expect(resident.every(([, tile]) => tile.visibilities.fullOf(false))).toBe(
      true,
    );
    f.model.tiles.setCacheBudget(0);
    expect(f.records().some(([, tile]) => tile.notVirtual)).toBe(false);
    expect(f.requests(TileRequestClass.DELETE)).toHaveLength(4);
  });

  it.each([0, 1])(
    "rebuilds an evicted tile with a %i byte budget",
    async (budget) => {
      const f = await setup();
      const creates = f.requests(TileRequestClass.CREATE).length;
      f.model.tiles.setCacheBudget(budget);
      f.hide(102);
      expect(f.tileFor(102).tile.notVirtual).toBe(false);
      f.show(102);
      expect(f.tileFor(102).tile.notVirtual).toBe(true);
      expect(f.requests(TileRequestClass.CREATE)).toHaveLength(creates + 1);
    },
  );
});
