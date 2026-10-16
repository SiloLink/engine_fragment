import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Pako from "pako";
import { FragmentsModel } from "./fragments-model";
import { MeshManager } from "./mesh-manager";
import { VirtualFragmentsModel } from "../virtual-model/virtual-fragments-model";
import { MaterialDefinition, ObjectClass, CurrentLod } from "./model-types";
import { LODGeometry, LODMesh, LodMaterial } from "../lod";

async function fixture() {
  const meshes = new MeshManager(() => {});
  const connection: any = {
    fetch: async (request: any) =>
      meshes.requests.handleRequest(meshes, request),
    fetchMeshCompute: () => {},
  };
  const path = fileURLToPath(
    new URL(
      "../../../../../../resources/frags/small_test.frag",
      import.meta.url,
    ),
  );
  const data = Pako.inflate(readFileSync(path));
  const worker = new VirtualFragmentsModel(
    "m",
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    connection,
    {
      multithreading: { meshConnectionThreshold: 0, meshConnectionRate: 0 },
    },
  );
  await worker.setupData();
  const invoke = vi.fn(
    async (_model: string, method: string, args: any[] = []) =>
      (worker as any)[method](...args),
  );
  const model = new FragmentsModel("m", meshes, { invoke } as any, {} as any);
  const ids = worker.getLocalIds().slice(0, 3);
  const definition = (id: number) => worker.getHighlight([id])[0];
  return { meshes, worker, model, invoke, ids, definition };
}

const base = (opacity: number, opacityGroup: number): MaterialDefinition => ({
  color: new THREE.Color(1, 0, 0),
  opacity,
  transparent: opacity < 1,
  opacityGroup,
  renderedFaces: 0 as any,
});
const request = {
  modelId: "m",
  objectClass: ObjectClass.SHELL,
  currentLod: CurrentLod.GEOMETRY,
};

describe("live opacity groups", () => {
  test("scalar changes reuse materials, preserve glass, and do not restart a view", async () => {
    const { model, meshes, worker, ids, definition, invoke } = await fixture();
    const group = await model.createOpacityGroup(ids, {
      opacity: 0.5,
      relative: true,
    });
    const id = definition(ids[0]).opacityGroup!;
    const frame = meshes.materials.get(base(1, id), request);
    const glass = meshes.materials.get(base(0.2, id), request);
    expect(frame.opacity).toBe(0.5);
    expect(glass.opacity).toBe(0.1);
    const restart = vi.spyOn(worker.tiles, "restart");
    const virtual = vi.spyOn(worker.tiles, "updateVirtualMeshes");
    const materialCount = meshes.materials.list.size;
    const version = frame.version;
    await group.setOpacity(0.4);
    expect(frame.version).toBe(version);
    const pending = group.setOpacity(0);
    expect(frame.visible).toBe(false);
    expect(frame.depthWrite).toBe(false);
    await pending;
    await group.setOpacity(1);
    expect(frame.opacity).toBe(1);
    expect(frame.transparent).toBe(false);
    expect(frame.version).toBe(version + 1);
    expect(frame.visible).toBe(true);
    expect(frame.depthWrite).toBe(true);
    expect(glass.opacity).toBe(0.2);
    expect(glass.transparent).toBe(true);
    expect(meshes.materials.get(base(1, id), request)).toBe(frame);
    expect(meshes.materials.list.size).toBe(materialCount);
    expect(restart).not.toHaveBeenCalled();
    expect(virtual).not.toHaveBeenCalled();
    expect(invoke.mock.calls.at(-1)).toEqual([
      "m",
      "setOpacityGroupValue",
      [id, 1],
    ]);
    const highlight = worker.itemConfig.getHighlight(
      worker.properties.getItemIdsFromLocalIds([ids[0]])[0],
    );
    expect(worker.materials.shouldUseOptimizedLayout(0, highlight)).toBe(false);
  });

  test("membership releases only still-owned opacity and keeps colors", async () => {
    const { model, ids, definition } = await fixture();
    const [a, b, c] = ids;
    await model.setColor(ids, new THREE.Color(1, 0, 0));
    const first = await model.createOpacityGroup(ids, {
      opacity: 0.4,
      relative: true,
    });
    const second = await model.createOpacityGroup([b], { opacity: 0.2 });
    const secondId = definition(b).opacityGroup;
    await model.setOpacity([c], 0.7);
    await first.setItems([]);
    expect(definition(a).opacityGroup).toBeUndefined();
    expect(definition(a).color).toBeDefined();
    expect(definition(b).opacityGroup).toBe(secondId);
    expect(definition(c).opacity).toBe(0.7);
    await second.dispose();
    expect(definition(b).opacityGroup).toBeUndefined();
    expect(definition(b).color).toBeDefined();
    expect(() => second.setOpacity(0.8)).toThrow("disposed");
  });

  test("late materials take the current scalar, reset and color changes compose", async () => {
    const { model, meshes, ids, definition } = await fixture();
    const group = await model.createOpacityGroup(ids, {
      opacity: 1,
      relative: true,
    });
    const id = definition(ids[0]).opacityGroup!;
    await group.setOpacity(0.3);
    expect(meshes.materials.get(base(0.2, id), request).opacity).toBeCloseTo(
      0.06,
    );
    await model.setColor([ids[0]], new THREE.Color(0, 1, 0));
    expect(definition(ids[0]).opacityGroup).toBe(id);
    await model.resetOpacity([ids[0]]);
    expect(definition(ids[0]).opacityGroup).toBeUndefined();
    expect(definition(ids[0]).color).toBeDefined();
    await group.setItems([ids[0]]);
    expect(definition(ids[0]).opacityGroup).toBe(id);
    await model.resetHighlight([ids[0]]);
    await group.dispose();
    expect(definition(ids[0])).toBeUndefined();
  });

  test("updates mixed LOD ranges and releases bindings when geometry changes", async () => {
    const { model, meshes, ids, definition } = await fixture();
    const first = await model.createOpacityGroup([ids[0]], {
      opacity: 0.5,
      relative: true,
    });
    const second = await model.createOpacityGroup([ids[1]], {
      opacity: 1,
      relative: true,
    });
    const firstId = definition(ids[0]).opacityGroup!;
    const secondId = definition(ids[1]).opacityGroup!;
    meshes.materials.addDefinitions("lod", []);
    // Feed the actual LOD manager a tile with two independent groups.
    const getProps = vi
      .spyOn(meshes.materials, "getHighlightProps")
      .mockImplementation((highlight) =>
        highlight === 1 ? base(0.2, firstId) : base(1, secondId),
      );
    const geometry = new LODGeometry();
    geometry.setAttribute(
      "itemFilter",
      new THREE.InstancedBufferAttribute(new Uint8Array([2, 2, 2, 2]), 1),
    );
    const material = new LodMaterial({ color: 0xffffff, opacity: 1 });
    const mesh = new LODMesh(geometry, [material]);
    meshes.lod.applyHighlight(mesh, {
      modelId: "m",
      material: 0,
      tileData: {
        highlightIds: [1, 2],
        highlightData: { position: [0, 4], size: [4, 4] },
      },
    });
    const values = () =>
      Array.from(geometry.getAttribute("itemHighlightOpacity").array);
    expect(values()[0]).toBeCloseTo(0.1);
    expect(values()[2]).toBe(1);
    await first.setOpacity(0);
    expect(values()).toEqual([0, 0, 1, 1]);
    expect(material.visible).toBe(true);
    await second.setOpacity(0);
    expect(material.visible).toBe(false);
    await second.setOpacity(1);
    expect(material.visible).toBe(true);
    expect(material.transparent).toBe(false);
    const before = geometry.getAttribute("itemHighlightOpacity").version;
    geometry.dispose();
    await first.setOpacity(0.8);
    expect(geometry.getAttribute("itemHighlightOpacity").version).toBe(before);
    getProps.mockRestore();
  });

  test("failed membership and disposal can be retried on the same handle", async () => {
    const { model, invoke, ids, definition } = await fixture();
    const group = await model.createOpacityGroup([ids[0]], { opacity: 0.4 });
    invoke.mockRejectedValueOnce(new Error("worker rejected membership"));
    await expect(group.setItems([ids[1]])).rejects.toThrow("membership");
    await group.setItems([ids[1]]);
    expect(definition(ids[0])?.opacityGroup).toBeUndefined();
    expect(definition(ids[1]).opacityGroup).toBeDefined();
    invoke.mockRejectedValueOnce(new Error("worker rejected disposal"));
    await expect(group.dispose()).rejects.toThrow("disposal");
    expect(group.isDisposed).toBe(false);
    await group.dispose();
    expect(group.isDisposed).toBe(true);
    expect(definition(ids[1])?.opacityGroup).toBeUndefined();
  });

  test("failed creation cleans up its worker ownership before a fresh retry", async () => {
    const { model, invoke, ids, worker, definition } = await fixture();
    invoke.mockImplementationOnce(async (_model, method, args) => {
      (worker as any)[method](...args);
      throw new Error("creation failed after applying");
    });
    await expect(
      model.createOpacityGroup(ids, { opacity: 0.4 }),
    ).rejects.toThrow("creation failed");
    expect(definition(ids[0])?.opacityGroup).toBeUndefined();
    const group = await model.createOpacityGroup(ids, { opacity: 0.7 });
    expect(group.opacity).toBe(0.7);
    expect(definition(ids[0]).opacityGroup).toBeDefined();
  });

  test("model disposal invalidates handles without resetting a retained scene", async () => {
    const { model, meshes, ids, definition, invoke } = await fixture();
    const group = await model.createOpacityGroup(ids, { opacity: 0.4 });
    const material = meshes.materials.get(
      base(1, definition(ids[0]).opacityGroup!),
      request,
    );
    const disposeData = vi
      .spyOn((model as any)._dataManager, "dispose")
      .mockResolvedValue(undefined);
    await model.dispose({ keepInScene: true });
    expect(group.isDisposed).toBe(true);
    expect(material.opacity).toBe(0.4);
    invoke.mockClear();
    await group.dispose();
    expect(invoke).not.toHaveBeenCalled();
    expect(() => group.setItems(ids)).toThrow("disposed");
    disposeData.mockRestore();
  });

  test("LOD materials are registered, tile-local, and released with their tile", async () => {
    const { model, meshes } = await fixture();
    const seen: THREE.Material[] = [];
    meshes.materials.list.onItemSet.add(({ value }) => {
      value.clippingPlanes = [new THREE.Plane()];
      seen.push(value);
    });
    const tileRequest = {
      ...request,
      objectClass: ObjectClass.LINE,
      currentLod: CurrentLod.WIRES,
      material: 0,
      tileId: 101,
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
    };
    // General material lookup keeps sharing/caching even for LINE requests.
    const shared = meshes.materials.getFromRequest(tileRequest);
    expect(meshes.materials.getFromRequest(tileRequest)).toBe(shared);
    const first = meshes.lod.createMesh(
      new THREE.BufferGeometry(),
      tileRequest,
    );
    const second = meshes.lod.createMesh(new THREE.BufferGeometry(), {
      ...tileRequest,
      tileId: 102,
    });
    expect(first.material[0]).not.toBe(second.material[0]);
    expect(seen).toContain(first.material[0]);
    expect(first.material[0].clippingPlanes).toHaveLength(1);
    model.tiles.set(101, first);
    model.tiles.set(102, second);
    const disposed = vi.fn();
    first.material[0].addEventListener("dispose", disposed);
    model.tiles.delete(101);
    expect(disposed).toHaveBeenCalledOnce();
    expect([...meshes.materials.list.values()]).not.toContain(
      first.material[0],
    );
    expect([...meshes.materials.list.values()]).toContain(second.material[0]);
  });

  test("invalid values do not mutate or message the worker", async () => {
    const { model, invoke, ids } = await fixture();
    const group = await model.createOpacityGroup(ids, { opacity: 0.5 });
    invoke.mockClear();
    for (const value of [NaN, Infinity, -0.1, 1.1])
      expect(() => group.setOpacity(value)).toThrow(RangeError);
    expect(group.opacity).toBe(0.5);
    expect(invoke).not.toHaveBeenCalled();
  });
});
