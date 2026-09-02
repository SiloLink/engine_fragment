import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { LODGeometry, LODMesh } from "../lod";
import { LodHelper } from "../lod/lod-helper";
import { LODManager } from "./lod-manager";

function createMesh() {
  const geometry = new LODGeometry();
  LodHelper.setLodBuffer(
    geometry,
    new Float32Array([
      0, 0, 0, 1, 0, 0,
      0, 1, 0, 1, 1, 0,
    ]),
  );
  const material = new THREE.ShaderMaterial();
  const mesh = new LODMesh(geometry, [material as never]);
  return { geometry, material, mesh };
}

describe("LODManager visibility", () => {
  const manager = new LODManager({} as never);

  it("does not submit a wire tile when every instance is inactive", () => {
    const { geometry, material, mesh } = createMesh();

    manager.updateVisibility(mesh, {
      visibilityData: undefined,
      highlightData: undefined,
    });

    expect(geometry.groups).toEqual([]);
    geometry.dispose();
    material.dispose();
  });

  it("submits a wire tile with visible or highlighted instances", () => {
    const visible = createMesh();
    manager.updateVisibility(visible.mesh, {
      visibilityData: {
        position: new Uint32Array([0]),
        size: new Uint32Array([0xffffffff]),
      },
      highlightData: undefined,
    });
    expect(visible.geometry.groups).toEqual([
      { start: 0, count: Infinity, materialIndex: 0 },
    ]);

    const highlighted = createMesh();
    manager.updateVisibility(highlighted.mesh, {
      visibilityData: undefined,
      highlightData: {
        position: new Uint32Array([0]),
        size: new Uint32Array([2]),
      },
    });
    expect(highlighted.geometry.groups).toEqual([
      { start: 0, count: Infinity, materialIndex: 0 },
    ]);

    visible.geometry.dispose();
    visible.material.dispose();
    highlighted.geometry.dispose();
    highlighted.material.dispose();
  });
});
