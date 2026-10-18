import { Buffer } from "node:buffer";
import { Box3, Euler, Matrix4, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { CurrentLod, ObjectClass } from "../../model/model-types";
import { normalizationValue, TileData } from "../virtual-meshes/types";
import { VirtualTilesController } from "./virtual-tiles-controller";

const attributes = [
  "positionBuffer",
  "normalBuffer",
  "faceIdBuffer",
  "indexBuffer",
  "ids",
] as const;

function expectSameBytes(actual: TileData, expected: TileData) {
  for (const attribute of attributes) {
    const a = actual[attribute];
    const b = expected[attribute];
    if (!a || !b) {
      expect(a, attribute).toBe(b);
      continue;
    }
    const bytesA = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    const bytesB = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    expect(bytesA.equals(bytesB), attribute).toBe(true);
  }
}

function baseTile(objectClass: ObjectClass): TileData {
  return {
    box: new Box3(),
    objectClass,
    lod: CurrentLod.GEOMETRY,
    materialId: 1,
    indexLocation: [],
    vertexLocation: [],
    geometriesLocation: [],
    sampleSpans: new Map(),
    size: 0,
    notVirtual: false,
  };
}

function createGeometry(remapped: boolean, lines = false): TileData {
  const geometry = baseTile(lines ? ObjectClass.LINE : ObjectClass.SHELL);
  geometry.positionBuffer = new Float32Array([
    -0, 0, 0, 0.125, -2.75, 3.1, -123.456, 0.001, -11, 5, 9, -8, 2.5, -3.5, 4.5,
    100_000.3, -50_000.7, 0.00001,
  ]);
  geometry.positionCount = geometry.positionBuffer.length;
  geometry.indexBuffer = new Uint16Array([0, 1, 2, 2, 3, 4, 4, 5, 0]);
  geometry.indexCount = geometry.indexBuffer.length;
  if (!lines) {
    geometry.normalBuffer = new Int16Array([
      0, 0, 0, 32767, 0, 0, 0, -32768, 0, 30000, -20000, 10000, -15, 23, -42, 1,
      1, 1,
    ]);
    geometry.normalCount = geometry.normalBuffer.length;
    geometry.faceIdBuffer = new Uint32Array([
      0, 1, 2, 0xfffffff0, 0xfffffffe, 0xffffffff,
    ]);
  }
  if (remapped) {
    const oldToNewVertex = new Uint16Array([4, 2, 5, 0, 3, 1]);
    geometry.renderLayout = {
      oldToNewVertex,
      indices: new Uint16Array([3, 1, 4, 5, 0, 3, 4, 2, 5]),
    };
  }
  return geometry;
}

function createTarget(geometry: TileData, vertexStart: number): TileData {
  const tile = baseTile(geometry.objectClass);
  const vertices = vertexStart + geometry.positionCount! / 3 + 2;
  tile.vertexLocation = [0, vertexStart];
  tile.indexLocation = [0, 3];
  tile.positionBuffer = new Float32Array(vertices * 3).fill(-7);
  tile.normalBuffer = geometry.normalBuffer
    ? new Int16Array(vertices * 3).fill(-7)
    : undefined;
  tile.faceIdBuffer = new Uint32Array(vertices).fill(7);
  tile.indexBuffer = new Uint16Array(geometry.indexCount! + 6).fill(7);
  tile.ids = new Uint8Array(vertices * 4).fill(233);
  return tile;
}

// The reference uses Three's public vector operations and DataView's uint32
// encoding. It deliberately does not duplicate the fused scalar kernel.
function writeReference(
  tile: TileData,
  geometry: TileData,
  matrix: Matrix4,
  sampleId: number,
  itemId: number,
  opaque: boolean,
) {
  const remap = geometry.renderLayout?.oldToNewVertex;
  const vertexStart = tile.vertexLocation[1];
  const vector = new Vector3();
  for (let old = 0; old < geometry.positionCount! / 3; old++) {
    const vertex = vertexStart + (remap ? remap[old] : old);
    vector
      .fromArray(geometry.positionBuffer!, old * 3)
      .applyMatrix4(matrix)
      .toArray(tile.positionBuffer!, vertex * 3);
    if (tile.normalBuffer) {
      vector
        .fromArray(geometry.normalBuffer!, old * 3)
        .transformDirection(matrix)
        .multiplyScalar(normalizationValue)
        .toArray(tile.normalBuffer, vertex * 3);
    }
    if (geometry.faceIdBuffer) {
      tile.faceIdBuffer![vertex] = geometry.faceIdBuffer[old] + sampleId * 100;
    }
  }

  const indices =
    opaque && geometry.renderLayout
      ? geometry.renderLayout.indices
      : geometry.indexBuffer!;
  indices.forEach((index, offset) => {
    const vertex = !opaque && remap ? remap[index] : index;
    tile.indexBuffer![tile.indexLocation[1] + offset] = vertexStart + vertex;
  });

  if (geometry.objectClass === ObjectClass.SHELL) {
    const encoded = new DataView(tile.ids!.buffer);
    for (let i = 0; i < geometry.positionCount! / 3; i++) {
      encoded.setUint32((vertexStart + i) * 4, itemId + 1, false);
    }
  }
}

function checkAttributes({
  matrix,
  remapped = false,
  opaque = true,
  itemId = 0xabcdef00,
  vertexStart = 3,
  lines = false,
}: {
  matrix: Matrix4;
  remapped?: boolean;
  opaque?: boolean;
  itemId?: number;
  vertexStart?: number;
  lines?: boolean;
}) {
  const geometry = createGeometry(remapped, lines);
  const originalGeometry = structuredClone(geometry);
  const actual = createTarget(geometry, vertexStart);
  const expected = createTarget(geometry, vertexStart);
  const controller = Object.create(VirtualTilesController.prototype) as any;
  Object.assign(controller, {
    _temp: { matrix, vector: new Vector3() },
    _materialController: { shouldUseOptimizedLayout: () => opaque },
    _samples: { getHighlight: () => 0 },
    itemId: () => itemId,
  });

  controller.setupTileSampleAttributes(actual, 1, geometry, { sample: 71 });
  writeReference(expected, geometry, matrix, 71, itemId, opaque);
  expectSameBytes(actual, expected);
  expectSameBytes(geometry, originalGeometry);
  expect(geometry.renderLayout).toEqual(originalGeometry.renderLayout);
  return actual;
}

const rigid = new Matrix4()
  .makeRotationFromEuler(new Euler(0.27, -0.49, 1.13))
  .setPosition(12.25, -3.5, 91.125);
const mirrored = rigid.clone().scale(new Vector3(1.5, 0.7, -2));
const projective = mirrored.clone();
projective.elements[3] = 0.001;
projective.elements[7] = -0.002;
projective.elements[11] = 0.003;

describe("tile attribute construction", () => {
  for (const [name, matrix] of [
    ["rigid", rigid],
    ["mirrored and nonuniform", mirrored],
    ["projective", projective],
  ] as const) {
    for (const remapped of [false, true]) {
      for (const opaque of [false, true]) {
        it(`preserves ${name} transforms, remapped=${remapped}, opaque=${opaque}`, () => {
          checkAttributes({ matrix, remapped, opaque });
        });
      }
    }
  }

  it.each([0, 255, 0x7ffffffe, 0xabcdef00, 0xfffffffe])(
    "preserves the full uint32 picker encoding for item %i",
    (itemId) => {
      checkAttributes({ matrix: rigid, itemId });
    },
  );

  it("writes remapped vertices through the last uint16 index", () => {
    const actual = checkAttributes({
      matrix: mirrored,
      remapped: true,
      opaque: false,
      vertexStart: 65530,
    });
    expect(actual.indexBuffer).toContain(65535);
  });

  it("transforms lines without introducing normals, face IDs or picker IDs", () => {
    checkAttributes({ matrix: projective, lines: true });
  });
});
