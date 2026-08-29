import { describe, expect, it } from "vitest";
import { ObjectClass } from "../../../model/model-types";
import { VirtualMemoryController } from "../../virtual-controllers";
import { ShellRenderLayoutOptimizer } from "./shell-render-layout";

function inverseRemap(remap: Uint16Array) {
  const inverse = new Uint16Array(remap.length);
  for (let oldVertex = 0; oldVertex < remap.length; oldVertex += 1) {
    inverse[remap[oldVertex]] = oldVertex;
  }
  return inverse;
}

function directedTriangles(indices: Uint16Array) {
  const result: string[] = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    result.push(
      `${indices[offset]}:${indices[offset + 1]}:${indices[offset + 2]}`,
    );
  }
  return result.sort();
}

describe("SHELL render layout", () => {
  it("builds a deterministic complete remap without mutating canonical indices", async () => {
    const optimizer = new ShellRenderLayoutOptimizer();
    await optimizer.prepare();
    const canonical = new Uint16Array([0, 2, 3, 3, 2, 0]);
    const snapshot = canonical.slice();

    const first = optimizer.create(canonical, 5);
    const repeated = optimizer.create(canonical, 5);
    const inverse = inverseRemap(first.oldToNewVertex);
    const reconstructed = new Uint16Array(
      first.indices.map((index) => inverse[index]),
    );

    expect(canonical).toEqual(snapshot);
    expect(first).toEqual(repeated);
    expect(first.indices).toBeInstanceOf(Uint16Array);
    expect(first.oldToNewVertex).toBeInstanceOf(Uint16Array);
    expect([...first.oldToNewVertex].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(directedTriangles(reconstructed)).toEqual(
      directedTriangles(canonical),
    );
  });

  it("includes the retained render plan in canonical geometry memory", async () => {
    const optimizer = new ShellRenderLayoutOptimizer();
    await optimizer.prepare();
    const indexBuffer = new Uint16Array([0, 1, 2]);
    const positionBuffer = new Float32Array(9);
    const normalBuffer = new Int16Array(9);
    const renderLayout = optimizer.create(indexBuffer, 3);
    const geometry = {
      objectClass: ObjectClass.SHELL,
      indexCount: indexBuffer.length,
      positionCount: positionBuffer.length,
      normalCount: normalBuffer.length,
      indexBuffer,
      positionBuffer,
      normalBuffer,
      renderLayout,
    };

    VirtualMemoryController.updateMeshMemory(geometry);

    expect(geometry.usedMemory).toBe(
      indexBuffer.byteLength +
        positionBuffer.byteLength +
        normalBuffer.byteLength +
        renderLayout.indices.byteLength +
        renderLayout.oldToNewVertex.byteLength,
    );
  });
});
