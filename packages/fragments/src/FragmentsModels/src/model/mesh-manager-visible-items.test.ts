import { afterEach, describe, expect, it, vi } from "vitest";
import { Box3, Color, Matrix4, Vector3 } from "three";
import { FragmentsModel } from "./fragments-model";
import { MeshManager } from "./mesh-manager";
import { CurrentLod, ObjectClass, TileRequestClass } from "./model-types";
import {
  TileCreate,
  TileRenderData,
  TileRequest,
} from "../multithreading/protocol";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const meshes = new MeshManager(() => {});
  const apply = (
    meshes as unknown as {
      processTileRequest(request: TileRequest): boolean;
    }
  ).processTileRequest.bind(meshes);
  const models: FragmentsModel[] = [];
  const threads = { fetch: vi.fn(async () => ({})), delete: vi.fn() };
  const addModel = (id = "model") => {
    const model = new FragmentsModel(id, meshes, threads as never, {} as never);
    models.push(model);
    meshes.materials.addDefinitions(id, [
      {
        color: new Color(1, 0, 0),
        opacity: 1,
        transparent: false,
        renderedFaces: 0,
      },
      {
        color: new Color(0, 0, 1),
        opacity: 0.5,
        transparent: true,
        renderedFaces: 0,
      },
    ]);
    meshes.list.set(id, model);
    return model;
  };
  const model = addModel();
  cleanups.push(() => {
    for (const owner of models) owner.tiles.clear();
    for (const id of new Set(models.map((owner) => owner.modelId)))
      meshes.materials.dispose(id);
    meshes.dispose();
  });

  const data = (ids: number[], highlighted = false): TileRenderData => ({
    visibleItemIds: Uint32Array.from(ids),
    visibilityData:
      ids.length && !highlighted
        ? {
            position: new Uint32Array([0]),
            size: new Uint32Array([0xffffffff]),
          }
        : undefined,
    highlightData:
      ids.length && highlighted
        ? { position: new Uint32Array([0]), size: new Uint32Array([3]) }
        : undefined,
    highlightIds: ids.length && highlighted ? new Uint32Array([1]) : undefined,
  });
  const create = (
    tileId: number,
    ids: number[],
    owner = model,
    wires = false,
    highlighted = false,
  ) => {
    const request: TileCreate = {
      tileRequestClass: TileRequestClass.CREATE,
      modelId: owner.modelId,
      tileId,
      objectClass: wires ? ObjectClass.LINE : ObjectClass.SHELL,
      currentLod: wires ? CurrentLod.WIRES : CurrentLod.GEOMETRY,
      material: 0,
      tileData: data(ids, highlighted),
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2]),
      normals: new Int16Array([0, 0, 32767, 0, 0, 32767, 0, 0, 32767]),
      // Picker bytes are deliberately different from the membership metadata.
      itemIds: new Uint8Array([0, 0, 0, 1, 0, 1, 17, 113, 0, 1, 17, 113]),
      faceIds: new Float32Array(9),
      matrix: new Matrix4(),
      aabb: new Box3(new Vector3(), new Vector3(1, 1, 0)),
    };
    if (wires) request.positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    expect(apply(request)).toBe(true);
    return owner.tiles.get(tileId)!;
  };
  const update = (tileId: number, ids: number[], owner = model) => {
    expect(
      apply({
        tileRequestClass: TileRequestClass.UPDATE,
        modelId: owner.modelId,
        tileId,
        objectClass: ObjectClass.SHELL,
        currentLod: CurrentLod.GEOMETRY,
        material: 0,
        tileData: data(ids),
      }),
    ).toBe(true);
  };
  const remove = (tileId: number, owner = model) =>
    apply({
      tileRequestClass: TileRequestClass.DELETE,
      modelId: owner.modelId,
      tileId,
    });
  return { meshes, model, addModel, create, update, remove };
}

describe("visible item membership of applied tiles", () => {
  it("uses true internal IDs including zero and large IDs, without decoding picker bytes", () => {
    const { model, create } = fixture();
    const tile = create(1, [0, 70000, 0]);
    expect(model.visibleItems).toEqual(new Set([0, 70000]));
    expect(tile.geometry.getAttribute("id").array).toEqual(
      new Uint8Array([0, 0, 0, 1, 0, 1, 17, 113, 0, 1, 17, 113]),
    );
  });

  it("keeps a shared item until its last active tile is removed", () => {
    const { model, create, remove } = fixture();
    create(1, [0, 70000]);
    create(2, [70000, 90000]);
    remove(1);
    expect(model.visibleItems).toEqual(new Set([70000, 90000]));
    remove(2);
    expect(model.visibleItems.size).toBe(0);
  });

  it("removes inactive retained geometry on UPDATE and restores it without CREATE", () => {
    const { model, create, update, remove } = fixture();
    const retained = create(1, [0, 70000]);
    create(2, [70000]);
    update(1, []);
    expect(model.tiles.get(1)).toBe(retained);
    expect(model.visibleItems).toEqual(new Set([70000]));
    update(1, [0, 70000]);
    update(1, [0, 70000]);
    remove(2);
    expect(model.visibleItems).toEqual(new Set([0, 70000]));
    remove(1);
    expect(model.visibleItems.size).toBe(0);
  });

  it("includes highlight-only and LOD geometry in the same membership union", () => {
    const { model, create, remove } = fixture();
    const highlighted = create(1, [70000], model, false, true);
    const lod = create(2, [70000, 90000], model, true);
    expect(highlighted.geometry.groups.length).toBeGreaterThan(0);
    expect(lod.geometry.groups.length).toBeGreaterThan(0);
    expect(model.visibleItems).toEqual(new Set([70000, 90000]));
    remove(1);
    expect(model.visibleItems).toEqual(new Set([70000, 90000]));
    remove(2);
    expect(model.visibleItems.size).toBe(0);
  });

  it("releases membership through direct public tile deletion and clearing", () => {
    const { model, create } = fixture();
    const tile = create(1, [0, 70000]);
    const disposed = vi.fn();
    tile.geometry.addEventListener("dispose", disposed);
    create(2, [70000, 90000]);
    model.tiles.delete(1);
    expect(disposed).toHaveBeenCalledOnce();
    expect(model.visibleItems).toEqual(new Set([70000, 90000]));
    model.tiles.clear();
    expect(model.visibleItems.size).toBe(0);
    expect(model.object.children).toHaveLength(0);
  });

  it("replaces a tile's membership without leaking old reference counts", () => {
    const { model, create, remove } = fixture();
    create(1, [0, 70000]);
    create(2, [70000]);
    create(1, [90000]);
    expect(model.visibleItems).toEqual(new Set([70000, 90000]));
    remove(2);
    expect(model.visibleItems).toEqual(new Set([90000]));
    remove(1);
    expect(model.visibleItems.size).toBe(0);
  });

  it("keeps replacement model lifetimes isolated even when old tiles are deleted later", () => {
    const { model, addModel, create, update } = fixture();
    create(1, [70000]);
    const replacement = addModel(model.modelId);
    expect(model.visibleItems.size).toBe(0);
    create(1, [70000], replacement);
    model.tiles.clear();
    expect(replacement.visibleItems).toEqual(new Set([70000]));
    update(1, [], replacement);
    expect(replacement.visibleItems.size).toBe(0);
  });

  it("can apply unchanged membership after removing and re-registering a model instance", () => {
    const { meshes, model, create, update, remove } = fixture();
    const tile = create(1, [70000]);
    meshes.list.delete(model.modelId);
    expect(model.visibleItems.size).toBe(0);
    expect(model.tiles.get(1)).toBe(tile);
    meshes.list.set(model.modelId, model);
    update(1, [70000]);
    expect(model.visibleItems).toEqual(new Set([70000]));
    create(2, [70000]);
    remove(1);
    expect(model.visibleItems).toEqual(new Set([70000]));
    remove(2);
    expect(model.visibleItems.size).toBe(0);
  });

  it("clears all model memberships when the model registry is cleared", () => {
    const { meshes, model, addModel, create } = fixture();
    const other = addModel("other");
    create(1, [70000]);
    create(1, [70000], other);
    meshes.list.clear();
    expect(model.visibleItems.size).toBe(0);
    expect(other.visibleItems.size).toBe(0);
  });

  it("clears a deferred-disposal model without affecting its replacement", async () => {
    const { model, addModel, create } = fixture();
    const tile = create(1, [70000]);
    await model.dispose({ keepInScene: true });
    expect(model.visibleItems.size).toBe(0);
    expect(model.tiles.get(1)).toBe(tile);
    const replacement = addModel(model.modelId);
    create(1, [70000], replacement);
    model.finalizeDispose();
    expect(replacement.visibleItems).toEqual(new Set([70000]));
    expect(model.tiles.size).toBe(0);
  });
});
