import { describe, expect, it } from "vitest";
import { Box3, Vector3 } from "three";
import {
  EditRequestType,
  EditUtils,
  RepresentationClass,
  ShellType,
  SingleThreadedFragmentsModel,
} from "../../../../../index";
import type { RawShell } from "../../../../../index";

type ShellMesh = {
  faceIdBuffer: Uint32Array;
  indexBuffer: Uint16Array;
  normalBuffer: Int16Array;
  positionBuffer: Float32Array;
};

type ShellManager = {
  fetchMeshes(meshId: number, evenVoid: boolean): ShellMesh | ShellMesh[];
};

function createRawShell({
  points,
  profiles,
  holes = new Map(),
  type = ShellType.NONE,
  profilesFaceIds,
}: Pick<RawShell, "points" | "profiles" | "profilesFaceIds"> &
  Partial<Pick<RawShell, "holes" | "type">>): RawShell {
  return {
    points,
    profiles: type === ShellType.BIG ? new Map() : profiles,
    holes: type === ShellType.BIG ? new Map() : holes,
    bigProfiles: type === ShellType.BIG ? profiles : new Map(),
    bigHoles: type === ShellType.BIG ? holes : new Map(),
    type,
    profilesFaceIds,
  };
}

function createShellMesh(shell: RawShell, bbox: number[]) {
  const empty = EditUtils.newModel({ raw: true });
  const core = EditUtils.getModelFromBuffer(empty, true);
  const { model: bytes } = EditUtils.edit(
    core,
    [
      {
        type: EditRequestType.CREATE_REPRESENTATION,
        localId: 1,
        data: {
          bbox,
          representationClass: RepresentationClass.SHELL,
          geometry: shell,
        },
      },
    ],
    { raw: true },
  );
  const model = new SingleThreadedFragmentsModel(
    `shell-indexing-${crypto.randomUUID()}`,
    bytes,
    true,
  );
  const manager = (model as any)._virtualModel.tiles._virtualMeshes.get(
    RepresentationClass.SHELL,
  ) as ShellManager | undefined;
  if (!manager) {
    model.dispose();
    throw new Error("Synthetic fragment has no SHELL manager");
  }
  return { manager, model };
}

function oneMesh(mesh: ShellMesh | ShellMesh[]) {
  if (Array.isArray(mesh)) throw new Error("Expected one Uint16 chunk");
  return mesh;
}

describe("indexed SHELL construction", () => {
  it.each([
    { faceIds: [0, 0], expectedVertices: 4 },
    { faceIds: [0, 1], expectedVertices: 6 },
  ])(
    "reuses a source point only across compatible face identity",
    ({ faceIds, expectedVertices }) => {
      const shell = createRawShell({
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
        ],
        profiles: new Map([
          [0, [0, 1, 2]],
          [1, [0, 2, 3]],
        ]),
        profilesFaceIds: faceIds,
      });
      const { manager, model } = createShellMesh(shell, [0, 0, 0, 1, 1, 0]);
      try {
        const mesh = oneMesh(manager.fetchMeshes(0, true));
        expect(mesh.positionBuffer.length / 3).toBe(expectedVertices);
        expect(mesh.indexBuffer).toHaveLength(6);
      } finally {
        model.dispose();
      }
    },
  );

  it("preserves polygon holes while indexing shared vertices", () => {
    const shell = createRawShell({
      points: [
        [0, 0, 0],
        [3, 0, 0],
        [3, 2, 0],
        [0, 2, 0],
        [1, 0.5, 0],
        [2, 0.5, 0],
        [2, 1.5, 0],
        [1, 1.5, 0],
      ],
      profiles: new Map([[0, [0, 1, 2, 3]]]),
      holes: new Map([[0, [[4, 5, 6, 7]]]]),
      profilesFaceIds: [0],
    });
    const { manager, model } = createShellMesh(shell, [0, 0, 0, 3, 2, 0]);
    try {
      const mesh = oneMesh(manager.fetchMeshes(0, true));
      expect(mesh.positionBuffer.length / 3).toBe(8);
      expect(mesh.indexBuffer).toHaveLength(24);
      expect(Math.max(...mesh.indexBuffer)).toBeLessThan(8);
    } finally {
      model.dispose();
    }
  });

  it("keeps every generated chunk within Uint16 vertex capacity", () => {
    const squareCount = 16_385;
    const points: number[][] = [];
    const profiles = new Map<number, number[]>();
    const profilesFaceIds: number[] = [];
    for (let square = 0; square < squareCount; square++) {
      const point = square * 4;
      const x = square * 2;
      points.push([x, 0, 0], [x + 1, 0, 0], [x + 1, 1, 0], [x, 1, 0]);
      profiles.set(square * 2, [point, point + 1, point + 2]);
      profiles.set(square * 2 + 1, [point, point + 2, point + 3]);
      profilesFaceIds.push(0, 0);
    }
    const shell = createRawShell({
      points,
      profiles,
      profilesFaceIds,
      type: ShellType.BIG,
    });
    const { manager, model } = createShellMesh(shell, [
      0,
      0,
      0,
      squareCount * 2,
      1,
      0,
    ]);
    try {
      const result = manager.fetchMeshes(0, true);
      const meshes = Array.isArray(result) ? result : [result];
      expect(meshes).toHaveLength(2);
      for (const mesh of meshes) {
        const vertexCount = mesh.positionBuffer.length / 3;
        expect(vertexCount).toBeLessThanOrEqual(65_536);
        expect(Math.max(...mesh.indexBuffer)).toBeLessThan(vertexCount);
      }
    } finally {
      model.dispose();
    }
  });
});

describe("spatial tile construction", () => {
  function createTileInternals() {
    const shell = createRawShell({
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      profiles: new Map([[0, [0, 1, 2]]]),
      profilesFaceIds: [0],
    });
    const contract = createShellMesh(shell, [0, 0, 0, 1, 1, 0]);
    const tiles = (contract.model as any)._virtualModel.tiles;
    return {
      ...contract,
      CrcConstructor: tiles._tileIdGenerator.constructor as new () => {
        value: number;
        compute(value: number): void;
      },
      internals: Object.getPrototypeOf(tiles),
    };
  }

  it("counts vertices rather than xyz components for tile capacity", () => {
    const { internals, model } = createTileInternals();
    try {
      const context = { _tiles: new Map() };
      expect(
        internals.checkTileMemoryOverflow.call(context, 1, {
          positionCount: 65_536 * 3,
        }),
      ).toBe(false);
      expect(
        internals.checkTileMemoryOverflow.call(context, 1, {
          positionCount: 65_537 * 3,
        }),
      ).toBe(true);
    } finally {
      model.dispose();
    }
  });

  it("derives each spatial bucket from the current sample box", () => {
    const { CrcConstructor, internals, model } = createTileInternals();
    try {
      const box = new Box3(
        new Vector3(64, 128, 192),
        new Vector3(96, 160, 224),
      );
      const expected = new CrcConstructor();
      expected.compute(64);
      expected.compute(128);
      expected.compute(192);
      const context = {
        _boxes: { get: () => box },
        _temp: { tileCenter: new Vector3(7, 7, 7) },
        _tileIdGenerator: new CrcConstructor(),
        getTileDimension: () => 32,
      };

      expect(internals.processTileSpatialId.call(context, 42, 0)).toBe(box);
      expect(context._tileIdGenerator.value).toBe(expected.value);
    } finally {
      model.dispose();
    }
  });
});
