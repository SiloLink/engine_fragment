import { afterEach, describe, expect, it } from "vitest";
import { ObjectClass } from "../../model/model-types";
import { TileData } from "../virtual-meshes/types";
import { VirtualMemoryController } from "./virtual-memory-controller";

function createShell() {
  const mesh = {
    objectClass: ObjectClass.SHELL,
    indexCount: 3,
    positionCount: 9,
    normalCount: 9,
    indexBuffer: new Uint16Array([0, 1, 2]),
    positionBuffer: new Float32Array(9),
    normalBuffer: new Int16Array(9),
    faceIdBuffer: new Uint32Array([0, 0, 0]),
    renderLayout: {
      indices: new Uint16Array([0, 1, 2]),
      oldToNewVertex: new Uint16Array([0, 1, 2]),
    },
  } as TileData;
  VirtualMemoryController.updateMeshMemory(mesh);
  return mesh;
}

describe("canonical geometry memory", () => {
  afterEach(() => {
    VirtualMemoryController.delete([1, 2]);
    VirtualMemoryController.setCapacity(200_000_000);
  });

  it("counts retained face IDs alongside geometry and its render layout", () => {
    const mesh = createShell();

    expect(mesh.usedMemory).toBe(84);
  });

  it("evicts canonical geometry when face IDs put it over the cache budget", () => {
    VirtualMemoryController.setCapacity(156);
    const first = createShell();
    const second = createShell();

    VirtualMemoryController.add(1, first);
    VirtualMemoryController.add(2, second);

    expect(VirtualMemoryController.get(1)).toBeUndefined();
    expect(VirtualMemoryController.get(2)).toBe(second);
  });
});
