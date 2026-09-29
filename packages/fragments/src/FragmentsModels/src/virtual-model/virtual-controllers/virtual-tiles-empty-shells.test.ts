import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frustum, Matrix4, PerspectiveCamera } from "three";
import {
  EditRequestType,
  EditUtils,
  RenderedFaces,
  RepresentationClass,
  ShellType,
  Stroke,
} from "../../../../index";
import type { EditRequest, RawShell } from "../../../../index";
import {
  CurrentLod,
  LodMode,
  ObjectClass,
  TileRequestClass,
} from "../../model/model-types";
import { VirtualFragmentsModel } from "../virtual-fragments-model";
import { VirtualTilesController } from "./virtual-tiles-controller";

const graphicsMemory = VirtualTilesController as any;

function shell(
  points: number[][],
  profiles: Map<number, number[]>,
  profilesFaceIds: number[],
): RawShell {
  return {
    points,
    profiles,
    holes: new Map(),
    bigProfiles: new Map(),
    bigHoles: new Map(),
    type: ShellType.NONE,
    profilesFaceIds,
  };
}

const emptyShell = shell([], new Map(), []);
const quadShell = shell(
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  new Map([
    [0, [0, 1, 2]],
    [1, [0, 2, 3]],
  ]),
  [0, 0],
);

// Localids: materials 1-2, representations 3-4, local transform 5, items
// 10+, global transforms 20+, samples 30+. Sample order follows creation, so
// the empty sample precedes the drawable one inside their shared tile.
const samples = [
  { item: 10, material: 1, representation: 3 }, // empty, shares a tile
  { item: 11, material: 1, representation: 4 }, // drawable
  { item: 12, material: 2, representation: 3 }, // empty, alone in its tile
];

function createModelBytes() {
  const transform = {
    position: [0, 0, 0],
    xDirection: [1, 0, 0],
    yDirection: [0, 1, 0],
  };
  const material = {
    r: 255,
    g: 255,
    b: 255,
    a: 1,
    renderedFaces: RenderedFaces.ONE,
    stroke: Stroke.DEFAULT,
  };
  const requests: EditRequest[] = [
    { type: EditRequestType.CREATE_MATERIAL, localId: 1, data: material },
    {
      type: EditRequestType.CREATE_MATERIAL,
      localId: 2,
      data: { ...material, r: 0 },
    },
    ...[emptyShell, quadShell].map((geometry, index) => ({
      type: EditRequestType.CREATE_REPRESENTATION as const,
      localId: 3 + index,
      data: {
        bbox: [0, 0, 0, 1, 1, 0],
        representationClass: RepresentationClass.SHELL,
        geometry,
      },
    })),
    {
      type: EditRequestType.CREATE_LOCAL_TRANSFORM,
      localId: 5,
      data: transform,
    },
  ];
  samples.forEach(({ item, material, representation }, index) => {
    requests.push(
      {
        type: EditRequestType.CREATE_ITEM,
        localId: item,
        data: { data: {}, category: "IFCBUILDINGELEMENTPROXY" },
      },
      {
        type: EditRequestType.CREATE_GLOBAL_TRANSFORM,
        localId: 20 + index,
        data: { ...transform, itemId: item },
      },
      {
        type: EditRequestType.CREATE_SAMPLE,
        localId: 30 + index,
        data: {
          item: 20 + index,
          material,
          representation,
          localTransform: 5,
        },
      },
    );
  });
  const core = EditUtils.getModelFromBuffer(
    EditUtils.newModel({ raw: true }),
    true,
  );
  return EditUtils.edit(core, requests, { raw: true }).model;
}

function createView(distance: number, renderRevision: number) {
  const camera = new PerspectiveCamera(45, 1, 0.1, 100_000);
  camera.position.set(0.5, 0.5, distance);
  camera.lookAt(0.5, 0.5, 0);
  camera.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    ),
  );
  return {
    cameraFrustum: frustum,
    cameraPosition: camera.position.clone(),
    fov: camera.fov,
    viewSize: 1000,
    graphicThreshold: Infinity,
    graphicQuality: 0.5,
    clippingPlanes: [],
    renderRevision,
  };
}

const cleanup: (() => void)[] = [];

async function createLoadedModel() {
  const posted: any[] = [];
  const connection = {
    fetch: async () => undefined,
    fetchMeshCompute(_modelId: string, list: any[]) {
      posted.push(...list);
    },
  };
  const model = new VirtualFragmentsModel(
    `empty-shells-${crypto.randomUUID()}`,
    createModelBytes() as any,
    connection as any,
    {
      multithreading: {
        meshConnectionRate: 60_000,
        meshConnectionThreshold: 0,
      },
    },
  );
  cleanup.push(() => model.dispose());
  await model.setupData();
  return { model, posted };
}

function sweep(model: VirtualFragmentsModel) {
  for (let tick = 0; tick < 10 && !model.tiles.tilesUpdated; tick++) {
    model.tiles.update(0);
  }
}

describe("SHELL tiles without drawable geometry", () => {
  let previousMemory: number;

  beforeEach(() => {
    previousMemory = graphicsMemory._graphicMemoryConsumed;
    graphicsMemory._graphicMemoryConsumed = 0;
  });

  afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
    graphicsMemory._graphicMemoryConsumed = previousMemory;
    vi.restoreAllMocks();
  });

  it.each([
    { name: "model LOD", distance: 5, pinned: false },
    { name: "a geometry pin", distance: 50_000, pinned: true },
  ])(
    "realizes only drawable SHELL geometry under $name",
    async ({ distance, pinned }) => {
      const { model, posted } = await createLoadedModel();
      model.setLodMode(LodMode.DEFAULT);
      model.refreshView(createView(distance, 7));
      if (pinned) {
        model.setItemsGeometryPinned(
          samples.map(({ item }) => item),
          true,
        );
      }

      sweep(model);

      // Every sample, empty or not, was evaluated at full geometry.
      expect(Array.from((model.tiles as any)._sampleLodState)).toEqual(
        samples.map(() => CurrentLod.GEOMETRY),
      );
      const creates = posted.filter(
        (request) =>
          request.tileRequestClass === TileRequestClass.CREATE &&
          request.objectClass === ObjectClass.SHELL,
      );
      expect(creates).toHaveLength(1);
      const [create] = creates;
      expect(Array.from(create.indices)).toEqual([0, 1, 2, 0, 2, 3]);
      expect(create.positions).toHaveLength(12);
      expect(create.normals).toHaveLength(12);
      expect(create.itemIds).toHaveLength(16);
      expect(create.matrix.elements.every(Number.isFinite)).toBe(true);
      expect(Array.from(create.positions).every(Number.isFinite)).toBe(true);
      expect(graphicsMemory._graphicMemoryConsumed).toBe(
        [
          create.positions,
          create.indices,
          create.normals,
          create.itemIds,
          create.faceIds,
        ].reduce((total, buffer) => total + buffer.byteLength, 0),
      );
      expect(posted.at(-1)).toEqual({
        tileRequestClass: TileRequestClass.FINISH,
        modelId: (model.tiles as any)._modelId,
        renderRevision: 7,
      });
    },
  );
});
