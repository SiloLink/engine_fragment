import { limitOf2Bytes } from "../../../model/model-types";
import { ShellRenderLayout } from "../types";

type MeshoptEncoderApi =
  (typeof import("meshoptimizer/encoder"))["MeshoptEncoder"];

export class ShellRenderLayoutOptimizer {
  private _encoder?: MeshoptEncoderApi;

  async prepare() {
    const { MeshoptEncoder } = await import("meshoptimizer/encoder");
    if (!MeshoptEncoder.supported) {
      throw new Error(
        "Fragments: SHELL render-layout optimization requires WebAssembly.",
      );
    }
    await MeshoptEncoder.ready;
    this._encoder = MeshoptEncoder;
  }

  create(indices: Uint16Array, vertexCount: number): ShellRenderLayout {
    const encoder = this._encoder;
    if (!encoder) {
      throw new Error(
        "Fragments: SHELL render-layout optimizer was not prepared.",
      );
    }
    this.validate(indices, vertexCount);

    const optimizedIndices = new Uint32Array(indices);
    const [partialRemap, referencedVertexCount] = encoder.reorderMesh(
      optimizedIndices,
      true,
      false,
    );
    const completeRemap = new Uint32Array(vertexCount);
    completeRemap.fill(0xffffffff);
    completeRemap.set(partialRemap);

    let nextVertex = referencedVertexCount;
    for (let oldVertex = 0; oldVertex < vertexCount; oldVertex++) {
      if (completeRemap[oldVertex] !== 0xffffffff) continue;
      completeRemap[oldVertex] = nextVertex;
      nextVertex++;
    }
    if (nextVertex !== vertexCount) {
      throw new Error("Fragments: Invalid SHELL render-layout remap.");
    }

    return {
      indices: new Uint16Array(optimizedIndices),
      oldToNewVertex: new Uint16Array(completeRemap),
    };
  }

  private validate(indices: Uint16Array, vertexCount: number) {
    if (
      indices.length === 0 ||
      indices.length % 3 !== 0 ||
      !Number.isSafeInteger(vertexCount) ||
      vertexCount <= 0 ||
      vertexCount > limitOf2Bytes
    ) {
      throw new Error("Fragments: Invalid indexed SHELL render layout.");
    }
    for (const index of indices) {
      if (index >= vertexCount) {
        throw new Error("Fragments: SHELL index exceeds its vertex buffer.");
      }
    }
  }
}
