import { expect, test } from "vitest";
import * as THREE from "three";
import type { Font } from "three/examples/jsm/Addons.js";
import { GridsManager } from "./grids-manager";
import type { FragmentsModel } from "./fragments-model";
import type { GridData } from "./model-types";

// Built grids nest grid > axis > line and labels. dispose() used to read
// `geometry` from the top-level grid groups, so it threw for every model
// whose grids had been built, and that model's disposal rejected.

const gridData: GridData[] = [
  {
    id: 1,
    transform: new THREE.Matrix4().toArray(),
    uAxes: [{ tag: "A", curve: [0, 0, 0, 10, 0, 0] }],
    vAxes: [{ tag: "1", curve: [0, 0, 0, 0, 10, 0] }],
    wAxes: [],
  },
];

const font = {
  generateShapes: () => [
    new THREE.Shape([
      new THREE.Vector2(0, 0),
      new THREE.Vector2(1, 0),
      new THREE.Vector2(0, 1),
    ]),
  ],
} as unknown as Font;

test("dispose releases every axis line and label of built grids", async () => {
  const manager = new GridsManager({
    modelId: "grids",
    threads: { invoke: async () => gridData },
  } as unknown as FragmentsModel);
  const grids = await manager.getGrids({ labels: { show: true, font } });
  new THREE.Scene().add(grids);

  const resources = new Set<THREE.BufferGeometry | THREE.Material>();
  grids.traverse((object) => {
    if (object instanceof THREE.Line || object instanceof THREE.Mesh) {
      resources.add(object.geometry);
      resources.add(object.material as THREE.Material);
    }
  });
  const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
  for (const resource of resources) {
    resource.addEventListener("dispose", () => disposed.add(resource));
  }
  // Two line geometries, one label geometry per tag, and both materials.
  expect(resources.size).toBe(6);

  manager.dispose();

  expect(disposed).toEqual(resources);
  expect(grids.parent).toBeNull();
  expect(grids.children).toHaveLength(0);
});
