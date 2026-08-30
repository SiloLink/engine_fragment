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
import { VirtualShellManager } from "../virtual-shell-manager";
import type { ShellRenderLayout } from "../types";
import { ShellTemplateConstructor } from "./shell-template-constructor";

type ShellMesh = {
  faceIdBuffer: Uint32Array;
  indexBuffer: Uint16Array;
  normalBuffer: Int16Array;
  positionBuffer: Float32Array;
  renderLayout?: ShellRenderLayout;
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

function createShellBytes(shell: RawShell, bbox: number[]) {
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
  return bytes;
}

function createShellMesh(shell: RawShell, bbox: number[]) {
  const bytes = createShellBytes(shell, bbox);
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

function createShellTemplate(shell: RawShell, bbox: number[]) {
  const bytes = createShellBytes(shell, bbox);
  const model = EditUtils.getModelFromBuffer(bytes, true);
  const schemaShell = model.meshes()!.shells(0)!;
  return new ShellTemplateConstructor().newMeshTemplate(schemaShell);
}

function oneMesh(mesh: ShellMesh | ShellMesh[]) {
  if (Array.isArray(mesh)) throw new Error("Expected one Uint16 chunk");
  return mesh;
}

describe("indexed SHELL construction", () => {
  it("caches one render layout beside immutable canonical buffers", async () => {
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
      profilesFaceIds: [0, 0],
    });
    const { manager, model } = createShellMesh(shell, [0, 0, 0, 1, 1, 0]);
    const canonical = oneMesh(manager.fetchMeshes(0, true));
    const canonicalSnapshot = {
      indices: canonical.indexBuffer.slice(),
      positions: canonical.positionBuffer.slice(),
      normals: canonical.normalBuffer.slice(),
    };
    const virtualModel = (model as any)._virtualModel;
    const renderManager = new VirtualShellManager(
      `shell-render-layout-${crypto.randomUUID()}`,
      virtualModel.tiles.meshes,
      true,
    );

    try {
      renderManager.setupTemplates();
      await renderManager.prepareRenderLayouts();
      const first = oneMesh(renderManager.fetchMeshes(0, true));
      const repeated = oneMesh(renderManager.fetchMeshes(0, true));

      expect(first.renderLayout).toBeDefined();
      expect(repeated).toBe(first);
      expect(repeated.renderLayout).toBe(first.renderLayout);
      expect(first.indexBuffer).toEqual(canonicalSnapshot.indices);
      expect(first.positionBuffer).toEqual(canonicalSnapshot.positions);
      expect(first.normalBuffer).toEqual(canonicalSnapshot.normals);
      expect(canonical.indexBuffer).toEqual(canonicalSnapshot.indices);
      expect(canonical.positionBuffer).toEqual(canonicalSnapshot.positions);
      expect(canonical.normalBuffer).toEqual(canonicalSnapshot.normals);
    } finally {
      renderManager.dispose();
      model.dispose();
    }
  });

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

  it("accepts a profile whose repeated contour entries fit after indexing", () => {
    const uniqueVertexCount = 32_769;
    const points = Array.from({ length: uniqueVertexCount }, (_, point) => [
      point,
      point % 2,
      0,
    ]);
    const profile = Array.from({ length: uniqueVertexCount * 2 }, (_, entry) =>
      Math.floor(entry / 2),
    );
    const shell = createRawShell({
      points,
      profiles: new Map([[0, profile]]),
      profilesFaceIds: [0],
      type: ShellType.BIG,
    });

    expect(() =>
      createShellTemplate(shell, [0, 0, 0, uniqueVertexCount - 1, 1, 0]),
    ).not.toThrow();
  });

  it("rejects a profile with more unique indexed vertices than Uint16 supports", () => {
    const vertexCount = 65_537;
    const points = Array.from({ length: vertexCount }, (_, point) => [
      point,
      point % 2,
      0,
    ]);
    const profile = Array.from({ length: vertexCount }, (_, point) => point);
    const shell = createRawShell({
      points,
      profiles: new Map([[0, profile]]),
      profilesFaceIds: [0],
      type: ShellType.BIG,
    });

    expect(() =>
      createShellTemplate(shell, [0, 0, 0, vertexCount - 1, 1, 0]),
    ).toThrow("Fragments: SHELL profile exceeds Uint16 vertex capacity.");
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

  it("starts a new chunk before an irregular profile can overflow Uint16", () => {
    const triangleCount = 21_000;
    const finalProfilePointCount = 3_000;
    const points: number[][] = [];
    const profiles = new Map<number, number[]>();
    const profilesFaceIds: number[] = [];
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const point = triangle * 3;
      const x = triangle * 2;
      points.push([x, 0, 0], [x + 1, 0, 0], [x, 1, 0]);
      profiles.set(triangle, [point, point + 1, point + 2]);
      profilesFaceIds.push(0);
    }

    const finalProfile: number[] = [];
    const finalProfileStart = points.length;
    for (let point = 0; point < finalProfilePointCount; point++) {
      const angle = (point / finalProfilePointCount) * Math.PI * 2;
      points.push([Math.cos(angle), Math.sin(angle), 1]);
      finalProfile.push(finalProfileStart + point);
    }
    profiles.set(triangleCount, finalProfile);
    profilesFaceIds.push(1);

    const shell = createRawShell({
      points,
      profiles,
      profilesFaceIds,
      type: ShellType.BIG,
    });
    const { manager, model } = createShellMesh(shell, [
      0,
      -1,
      0,
      triangleCount * 2,
      1,
      1,
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
