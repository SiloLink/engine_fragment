import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { LODManager } from "./lod-manager";
import { LODGeometry, LODMesh } from "../lod";
import { LodMaterial } from "../lod/lod-material";
import { LodHelper } from "../lod/lod-helper";

/** One LOD tile of four line instances, in two highlighted chunks. */
const createTile = () => {
  const geometry = new LODGeometry();
  geometry.setAttribute(
    "itemFilter",
    new THREE.InstancedBufferAttribute(new Uint8Array(4), 1),
  );
  const material = new LodMaterial(
    LodHelper.newLodMaterialParams({ color: 0xffffff, opacity: 1 } as any),
  );
  const mesh = new LODMesh(geometry, [material]);
  return { geometry, material, mesh };
};

// The worker sends chunk positions and sizes in doubled instance units.
const twoChunks = { position: [0, 4], size: [4, 4] };

const applyHighlights = (
  mesh: LODMesh,
  definitions: Record<number, { color?: THREE.Color; opacity: number }>,
  highlightIds: number[],
) => {
  const materials = {
    getHighlightProps: (highlightId: number) => definitions[highlightId],
  };
  new LODManager(materials as any).applyHighlight(mesh, {
    tileData: { highlightIds, highlightData: twoChunks },
    modelId: "m",
    material: 0,
  });
};

const instanceOpacities = (geometry: LODGeometry) =>
  Array.from(
    geometry.getAttribute("itemHighlightOpacity").array as Float32Array,
  );

describe("LOD highlights", () => {
  test("a colored item and a faded one in one tile keep their own opacity, in either order", () => {
    const colored = { color: new THREE.Color(1, 0, 0), opacity: 0.2 };
    const faded = { opacity: 0.1 };

    const first = createTile();
    applyHighlights(first.mesh, { 1: colored, 2: faded }, [1, 2]);
    const second = createTile();
    applyHighlights(second.mesh, { 1: faded, 2: colored }, [1, 2]);

    for (const [opacities, expected] of [
      [instanceOpacities(first.geometry), [0.2, 0.2, 0.1, 0.1]],
      [instanceOpacities(second.geometry), [0.1, 0.1, 0.2, 0.2]],
    ]) {
      expected.forEach((value, instance) =>
        expect(opacities[instance]).toBeCloseTo(value),
      );
    }
    expect(first.material.transparent).toBe(true);
    const colors = first.geometry.getAttribute("itemHighlightColor").array;
    expect(Array.from(colors).slice(0, 3)).toEqual([1, 0, 0]);
  });

  test("an opaque highlight keeps the tile opaque", () => {
    const { geometry, material, mesh } = createTile();
    applyHighlights(mesh, { 1: { opacity: 1 }, 2: { opacity: 1 } }, [1, 2]);

    expect(instanceOpacities(geometry)).toEqual([1, 1, 1, 1]);
    expect(material.transparent).toBe(false);
  });
});
