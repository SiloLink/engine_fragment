import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { MeshManager } from "./mesh-manager";
import { TileIndexUpdate } from "../multithreading/protocol";
import { CurrentLod, ObjectClass } from "./model-types";

type Visibility = { position: number[]; size: number[] };

const white = 0xffffffff;
const twoRuns = { position: [3, 12], size: [3, 3] };
const threeRuns = { position: [0, 6, 12], size: [3, 3, white] };
const otherRuns = { position: [3, 9, 15], size: [3, 3, 3] };

function tile(ArrayType: Uint16ArrayConstructor | Uint32ArrayConstructor) {
  const manager = new MeshManager(() => {});
  // Exercise 32-bit values too, so narrowing an index would change geometry.
  const offset = ArrayType === Uint32Array ? 0x10000 : 100;
  const full = new ArrayType(Array.from({ length: 18 }, (_, i) => offset + i));
  const original = full.slice();
  const geometry = new THREE.BufferGeometry();
  manager["setIndex"](geometry, full);
  const index = geometry.index!;
  const mesh = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial()]);
  manager.materials.addDefinitions("model", [
    {
      color: new THREE.Color(0.5, 0.5, 0.5),
      opacity: 1,
      transparent: false,
      renderedFaces: 0,
    },
    {
      color: new THREE.Color(0, 1, 0),
      opacity: 1,
      transparent: false,
      renderedFaces: 0,
    },
  ]);

  function update(
    visibilityData?: Visibility,
    highlighted?: boolean,
    indexUpdates?: TileIndexUpdate[],
  ) {
    for (const patch of indexUpdates ?? [])
      original.set(patch.indices, patch.start);
    manager["updateStatus"](mesh, {
      modelId: "model",
      objectClass: ObjectClass.SHELL,
      currentLod: CurrentLod.GEOMETRY,
      material: 0,
      indexUpdates,
      tileData: {
        visibilityData,
        highlightData: highlighted ? { position: [9], size: [3] } : undefined,
        highlightIds: highlighted ? [1] : undefined,
      },
    });
    // Sharing or replacing the CPU array must not recreate/resize the GPU
    // attribute, narrow 32-bit indices, or mutate the canonical source.
    expect(geometry.index).toBe(index);
    expect(index.array).toBeInstanceOf(ArrayType);
    expect(index.array.length).toBe(full.length);
    expect(index.count).toBe(full.length);
    expect(geometry.userData.fullIndex).toBe(full);
    expect(full).toEqual(original);
  }

  function compactedOffsets() {
    return Array.from(
      index.array.slice(0, geometry.drawRange.count),
      (value) => value - offset,
    );
  }

  return { full, geometry, index, mesh, update, compactedOffsets };
}

describe.each([Uint16Array, Uint32Array])(
  "%s lazy compacted indices",
  (ArrayType) => {
    test("shares the full index until a tile needs compaction", () => {
      const { full, geometry, index, update } = tile(ArrayType);
      expect(index.array).toBe(full);
      // A first highlight must not allocate a copy, even with many runs.
      update(threeRuns, true);
      expect(index.array).toBe(full);
      expect(index.version).toBe(0);
      for (const visibility of [
        undefined,
        { position: [], size: [] },
        twoRuns,
      ]) {
        update(visibility);
        expect(index.array).toBe(full);
        expect(index.version).toBe(0);
        expect(geometry.drawRange).toEqual({ start: 0, count: Infinity });
      }
      expect(geometry.groups).toEqual([
        { start: 3, count: 3, materialIndex: 0 },
        { start: 12, count: 3, materialIndex: 0 },
      ]);
    });

    test("copies visible runs from the full index and reuses the working array", () => {
      const { full, geometry, index, update, compactedOffsets } =
        tile(ArrayType);
      update(threeRuns);
      const working = index.array;
      expect(working).not.toBe(full);
      expect(working.buffer).not.toBe(full.buffer);
      expect(compactedOffsets()).toEqual([
        0, 1, 2, 6, 7, 8, 12, 13, 14, 15, 16, 17,
      ]);
      expect(geometry.groups).toEqual([
        { start: 0, count: 12, materialIndex: 0 },
      ]);
      expect(index.version).toBe(1);

      update(otherRuns);
      expect(index.array).toBe(working);
      expect(compactedOffsets()).toEqual([3, 4, 5, 9, 10, 11, 15, 16, 17]);
      expect(geometry.groups).toEqual([
        { start: 0, count: 9, materialIndex: 0 },
      ]);
      expect(index.version).toBe(2);
    });

    test("publishes each packing and drops it with the full index", () => {
      const { full, geometry, index, update } = tile(ArrayType);
      update(twoRuns);
      expect(geometry.userData.compactRuns).toBeUndefined();

      update(threeRuns);
      const packing = geometry.userData.compactRuns;
      // The white run reaches the end of the full index.
      expect(packing).toEqual({
        start: new Uint32Array([0, 6, 12]),
        count: new Uint32Array([3, 3, 6]),
        offset: new Uint32Array([0, 3, 6]),
      });
      // Each packed run holds its full-index slots from its offset on.
      for (let i = 0; i < packing.start.length; i++) {
        const start = packing.start[i];
        const count = packing.count[i];
        const offset = packing.offset[i];
        expect(index.array.slice(offset, offset + count)).toEqual(
          full.slice(start, start + count),
        );
      }
      expect(packing.offset.at(-1) + packing.count.at(-1)).toBe(
        geometry.drawRange.count,
      );

      update(otherRuns);
      expect(geometry.userData.compactRuns).not.toBe(packing);
      expect(geometry.userData.compactRuns).toEqual({
        start: new Uint32Array([3, 9, 15]),
        count: new Uint32Array([3, 3, 3]),
        offset: new Uint32Array([0, 3, 6]),
      });

      // A run past the end of the index packs nothing and is left out.
      update({ position: [0, 6, 18], size: [3, 3, 3] });
      expect(geometry.userData.compactRuns).toEqual({
        start: new Uint32Array([0, 6]),
        count: new Uint32Array([3, 3]),
        offset: new Uint32Array([0, 3]),
      });

      update(threeRuns, true);
      expect(geometry.userData.compactIndex).toBe(false);
      expect("compactRuns" in geometry.userData).toBe(false);
    });

    test("reuses one working copy across repeated compaction threshold transitions", () => {
      const { full, geometry, index, update, compactedOffsets } =
        tile(ArrayType);
      update(twoRuns);
      expect(index.array).toBe(full);
      update(threeRuns);
      const working = index.array;

      for (let i = 0; i < 20; i++) {
        update(twoRuns);
        expect(index.array).toBe(working);
        expect(index.array).toEqual(full);
        expect(index.version).toBe(2 + i * 2);
        expect(geometry.userData.compactIndex).toBe(false);
        expect(geometry.drawRange).toEqual({ start: 0, count: Infinity });
        expect(geometry.groups).toEqual([
          { start: 3, count: 3, materialIndex: 0 },
          { start: 12, count: 3, materialIndex: 0 },
        ]);
        update(twoRuns);
        expect(index.version).toBe(2 + i * 2);

        update(otherRuns);
        expect(index.array).not.toBe(full);
        expect(index.array).toBe(working);
        expect(compactedOffsets()).toEqual([3, 4, 5, 9, 10, 11, 15, 16, 17]);
      }
    });

    test("restores canonical offsets and reuses one working copy across repeated highlights", () => {
      const { full, geometry, index, mesh, update, compactedOffsets } =
        tile(ArrayType);
      update(threeRuns);
      const working = index.array;
      expect(working).not.toBe(full);
      for (let i = 0; i < 20; i++) {
        update(threeRuns);
        expect(index.array).toBe(working);
        expect(compactedOffsets()).toEqual([
          0, 1, 2, 6, 7, 8, 12, 13, 14, 15, 16, 17,
        ]);

        update(threeRuns, true);
        expect(index.array).toBe(working);
        expect(index.array).toEqual(full);
        expect(geometry.userData.compactIndex).toBe(false);
        expect(geometry.drawRange).toEqual({ start: 0, count: Infinity });
        const highlightGroup = geometry.groups.at(-1)!;
        expect(highlightGroup).toMatchObject({
          start: 9,
          count: 3,
        });
        expect(highlightGroup.materialIndex).toBeGreaterThan(0);
        const highlighted = mesh.material[
          highlightGroup.materialIndex!
        ] as THREE.MeshLambertMaterial;
        expect(highlighted.color).toEqual(new THREE.Color(0, 1, 0));
        const restoredVersion = index.version;
        update(threeRuns, true);
        expect(index.array).toBe(working);
        expect(index.array).toEqual(full);
        expect(index.version).toBe(restoredVersion);

        update(otherRuns);
        expect(index.array).toBe(working);
        expect(index.array).not.toBe(full);
        update(threeRuns);
        expect(index.array).toBe(working);
      }
      update(undefined);
      expect(index.array).toBe(working);
      expect(index.array).toEqual(full);
    });

    test("updates full-index chunks in place across compacted and highlighted states", () => {
      const { full, geometry, index, update, compactedOffsets } =
        tile(ArrayType);
      const offset = full[0];
      const patches = [
        { start: 3, indices: new Uint16Array([7, 8, 9]) },
        { start: 12, indices: new Uint16Array([2, 1, 0]) },
      ];
      update(threeRuns);
      const working = index.array;
      update(threeRuns, false, patches);
      expect(index.array).toBe(working);
      expect(full.subarray(3, 6)).toEqual(new ArrayType(patches[0].indices));
      expect(full.subarray(12, 15)).toEqual(new ArrayType(patches[1].indices));
      expect(compactedOffsets().slice(6, 9)).toEqual(
        Array.from(patches[1].indices, (value) => value - offset),
      );

      // Highlight and selection ranges still address the full tile index.
      update(twoRuns, true);
      expect(index.array).toBe(working);
      expect(index.array).toEqual(full);
      expect(geometry.userData.compactIndex).toBe(false);
      expect(geometry.groups.at(-1)).toMatchObject({ start: 9, count: 3 });

      const restore = [{ start: 3, indices: new Uint16Array([10, 11, 12]) }];
      update(twoRuns, true, restore);
      expect(index.array).toBe(working);
      expect(index.array).toEqual(full);
      expect(Array.from(index.array.slice(3, 6))).toEqual([10, 11, 12]);
    });

    test("preserves empty and clipped runs and restores indices for empty visibility", () => {
      const { full, geometry, index, update, compactedOffsets } =
        tile(ArrayType);
      update({ position: [0, 6, 15], size: [0, 3, 100] });
      const working = index.array;
      expect(compactedOffsets()).toEqual([6, 7, 8, 15, 16, 17]);
      expect(geometry.groups).toEqual([
        { start: 0, count: 6, materialIndex: 0 },
      ]);

      update({ position: [], size: [] });
      expect(index.array).toBe(working);
      expect(index.array).toEqual(full);
      expect(geometry.drawRange).toEqual({ start: 0, count: Infinity });
      expect(geometry.groups).toEqual([]);
    });
  },
);
