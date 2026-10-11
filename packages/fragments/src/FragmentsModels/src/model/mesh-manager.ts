import { TileRequest } from "../multithreading/protocol";
import * as THREE from "three";
import { MaterialManager } from "./material-manager";
import {
  TileRequestClass,
  ObjectClass,
  CurrentLod,
  BIMMesh,
} from "./model-types";
import { FragmentsModel } from "./fragments-model";
import { DataMap } from "../../../Utils";
import { RequestsManager } from "./requests-manager";
import { LODManager } from "./lod-manager";
import { LODMesh } from "../lod";
import { MultithreadingHelper } from "../multithreading/multithreading-helper";
import { FragmentsMultiDrawMesh } from "./fragments-multi-draw-mesh";
import { ModelViewUpdateError } from "./model-view-error";

type ViewCompletion = {
  firstRevision: number;
  requested: number;
  completed: number;
  failure?: { revision: number; error: unknown };
};

type ViewFence = {
  targets: { model: FragmentsModel; revision: number }[];
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Since three r185, `updateWorldMatrix()` only recomputes an object whose
 * own flag is set, and a parent's move reaches children only on the
 * downward pass. A tile never sets its flag after creation, so moving an
 * already-rendered model left getWorldPosition, Box3.setFromObject... on
 * the old placement until the next render (#309). Tiles always recompute
 * here, as every three version up to r184 did. Renders use
 * `updateMatrixWorld()`, not this, so their cost does not change.
 */
function updateTileWorldMatrix(
  this: THREE.Object3D,
  updateParents?: boolean,
  updateChildren?: boolean,
) {
  // The third argument (`force`) exists since r185; older versions ignore it.
  (THREE.Object3D.prototype.updateWorldMatrix as any).call(
    this,
    updateParents,
    updateChildren,
    true,
  );
}

/**
 * A class that manages the creation and updating of meshes in a Fragments model.
 */
export class MeshManager {
  /**
   * A map of FragmentsModel instances by their model ID.
   */
  readonly list = new DataMap<string, FragmentsModel>();
  readonly materials = new MaterialManager();
  readonly lod = new LODManager(this.materials);
  readonly requests = new RequestsManager();

  private readonly updateThreshold = 4;

  // Unique across model lifetimes, including replacements with the same ID.
  private _nextViewRevision = 0;
  private readonly _views = new WeakMap<FragmentsModel, ViewCompletion>();
  private _fenceWaiters: ViewFence[] = [];

  private _onUpdate: () => void;

  constructor(onUpdate: () => void) {
    this._onUpdate = onUpdate;
    this.requests.onFinish = () => this.drainAll();
    this.list.onItemDeleted.add(() => this.settleViewFences());
    this.list.onItemUpdated.add(() => this.settleViewFences());
    this.list.onCleared.add(() => this.settleViewFences());
  }

  beginViewUpdate(model: FragmentsModel) {
    const revision = ++this._nextViewRevision;
    const state = this._views.get(model);
    if (state) {
      state.requested = revision;
    } else {
      this._views.set(model, {
        firstRevision: revision,
        requested: revision,
        completed: 0,
      });
    }
    return revision;
  }

  failViewUpdate(model: FragmentsModel, revision: number, cause: unknown) {
    const error = new ModelViewUpdateError(
      "view-failed",
      model.modelId,
      revision,
      cause,
    );
    const state = this._views.get(model);
    if (state && revision > (state.failure?.revision ?? 0)) {
      state.failure = { revision, error };
    }
    // Like completion, a failure of the latest requested view reaches the
    // model itself; a stale revision's failure does not.
    if (state && revision >= state.requested) model._failProcessing(error);
    this.settleViewFences();
    return error;
  }

  /** Wait for each currently requested model view and its tile changes on main. */
  async forceUpdateFinish() {
    const targets: ViewFence["targets"] = [];
    for (const model of this.list.values()) {
      const state = this._views.get(model);
      if (state) targets.push({ model, revision: state.requested });
    }
    await new Promise<void>((resolve, reject) => {
      this._fenceWaiters.push({ targets, resolve, reject });
      this.drainAll();
      this.settleViewFences();
    });
  }

  private finishView(model: FragmentsModel, revision: number) {
    const state = this._views.get(model);
    if (!state || !(revision >= state.firstRevision)) return;
    state.completed = Math.max(state.completed, revision);
    if (revision >= state.requested) model._finishProcessing();
    this.settleViewFences();
  }

  private settleViewFences() {
    this._fenceWaiters = this._fenceWaiters.filter((waiter) => {
      let pending = false;
      for (const { model, revision } of waiter.targets) {
        if (this.list.get(model.modelId) !== model) {
          waiter.reject(
            new ModelViewUpdateError("model-removed", model.modelId, revision),
          );
          return false;
        }
        const state = this._views.get(model)!;
        if (state.completed >= revision) continue;
        if (state.failure && state.failure.revision >= revision) {
          waiter.reject(state.failure.error);
          return false;
        }
        pending = true;
      }
      if (!pending) waiter.resolve();
      return pending;
    });
  }

  /**
   * Process every queued tile request without the per-frame
   * `updateThreshold` cap. Used by force-flush paths where the
   * caller is explicitly waiting for everything to settle —
   * spreading the work across many frames there would just delay
   * the visual.
   */
  private drainAll() {
    while (this.requests.arePending) {
      const request = this.requests.list.shift();
      if (!request) continue;
      this.processTileRequest(request);
      if (!MultithreadingHelper.isFinishRequest(request)) this._onUpdate();
    }
  }

  update() {
    const start = performance.now();
    while (this.requests.arePending) {
      const request = this.requests.list.shift();
      if (!request) continue;
      this.processTileRequest(request);
      if (!MultithreadingHelper.isFinishRequest(request)) this._onUpdate();
      if (performance.now() - start > this.updateThreshold) return;
    }
  }

  private setTileData(mesh: BIMMesh, request: any) {
    const { tileId, itemId, matrix, aabb } = request;
    this.setMeshData(mesh, tileId, itemId, matrix);
    this.setupBoundings(mesh, aabb);
    this.updateStatus(mesh, request);
  }

  private processTileRequest(request: TileRequest) {
    const { tileRequestClass, modelId } = request;
    const model = this.list.get(modelId);
    if (!model) return;
    if (tileRequestClass === TileRequestClass.CREATE) {
      if (request.objectClass === undefined) return;
      const tile = this.create(request);
      this.setTileData(tile, request);
      const uniqueIds = this.extractUniqueItemIds(request.itemIds);
      tile.userData.itemIds = uniqueIds;
      this.trackVisibleItems(model, uniqueIds, true);
      model.tiles.set(tile.userData.tileId, tile);
    } else if (tileRequestClass === TileRequestClass.DELETE) {
      const tile = model.tiles.get(request.tileId);
      if (tile?.userData.itemIds) {
        this.trackVisibleItems(model, tile.userData.itemIds, false);
      }
      model.tiles.delete(request.tileId);
    } else if (tileRequestClass === TileRequestClass.UPDATE) {
      const tileObject = model.tiles.get(request.tileId);
      if (tileObject) this.updateStatus(tileObject, request);
    } else if (tileRequestClass === TileRequestClass.FINISH) {
      if (request.error === undefined) {
        this.finishView(model, request.renderRevision);
      } else {
        this.failViewUpdate(model, request.renderRevision, request.error);
      }
    }
  }

  private extractUniqueItemIds(itemIds: any): Set<number> {
    const unique = new Set<number>();
    if (!itemIds) return unique;
    for (let i = 0; i < itemIds.length; i++) {
      unique.add(itemIds[i]);
    }
    return unique;
  }

  private trackVisibleItems(
    model: FragmentsModel,
    itemIds: Set<number>,
    added: boolean,
  ) {
    for (const itemId of itemIds) {
      if (added) {
        model.visibleItems.add(itemId);
      } else {
        model.visibleItems.delete(itemId);
      }
    }
  }

  private createMesh(request: any) {
    const { indices, positions, normals, itemIds, faceIds } = request;
    const geometry = new THREE.BufferGeometry();
    this.setIndex(geometry, indices);
    this.setPositions(positions, geometry);
    this.setNormals(normals, geometry);
    this.setItemIds(itemIds, geometry);
    this.setFaceIds(faceIds, geometry);
    const material = this.materials.getFromRequest(request);
    return new FragmentsMultiDrawMesh(geometry, [material]);
  }

  private setupBoundings(mesh: BIMMesh, aabb: any) {
    const { geometry } = mesh;
    const box = new THREE.Box3().copy(aabb);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    geometry.boundingBox = box;
    geometry.boundingSphere = sphere;
  }

  private create(request: any): BIMMesh {
    if (request.objectClass === ObjectClass.SHELL)
      return this.createMesh(request);
    if (request.objectClass === ObjectClass.LINE) {
      const geometry = new THREE.BufferGeometry();
      return this.lod.createMesh(geometry, request);
    }
    throw new Error(
      `Fragments: object class ${request.objectClass} is not supported.`,
    );
  }

  private updateStatus(mesh: BIMMesh, request: any) {
    const {
      tileData: { highlightData, visibilityData },
      currentLod,
    } = request;

    const { geometry } = mesh;
    geometry.clearGroups();

    if (
      currentLod !== CurrentLod.WIRES &&
      this.applyCompactIndex(geometry, visibilityData, !!highlightData)
    ) {
      return;
    }

    this.lod.processMesh(mesh, request);

    if (!highlightData) return;

    if (currentLod === CurrentLod.WIRES) {
      this.lod.applyHighlight(mesh as LODMesh, request);
      return;
    }

    const materials = this.materials.createHighlights(mesh, request);
    mesh.material = materials;
  }

  /**
   * Minimum number of visibility runs before a shell tile switches from
   * one geometry.group per run (one draw call each) to a compacted index
   * buffer drawn with a single call. Small run counts stay on the group
   * path: the copy is not worth it and highlights need groups anyway.
   */
  private static readonly compactMinRuns = 3;

  /**
   * Rewrite the tile's GPU index with just the visible runs so the whole
   * tile is one draw call. Returns false (after restoring the full index
   * if it was compacted before) when the group path must be used:
   * LOD/wire meshes, tiles without a CPU index copy, highlighted tiles
   * (highlight groups address the full index) and tiles with few runs.
   */
  private applyCompactIndex(
    geometry: THREE.BufferGeometry,
    visibilityData:
      | { position: ArrayLike<number>; size: ArrayLike<number> }
      | undefined,
    hasHighlight: boolean,
  ) {
    const full = geometry.userData.fullIndex as
      | Uint16Array
      | Uint32Array
      | undefined;
    const index = geometry.index;
    if (!full || !index) return false;

    const runs = visibilityData ? visibilityData.position.length : 0;
    if (hasHighlight || runs < MeshManager.compactMinRuns) {
      this.restoreFullIndex(geometry, full);
      return false;
    }

    const target = index.array as Uint16Array | Uint32Array;
    const { position, size } = visibilityData!;
    let count = 0;
    for (let i = 0; i < runs; i++) {
      const start = position[i];
      const isWhite = size[i] === this.white;
      const end = isWhite
        ? full.length
        : Math.min(full.length, start + size[i]);
      if (end <= start) continue;
      target.set(full.subarray(start, end), count);
      count += end - start;
    }

    index.needsUpdate = true;
    geometry.setDrawRange(0, count);
    geometry.addGroup(0, count, 0);
    geometry.userData.compactIndex = true;
    return true;
  }

  private restoreFullIndex(
    geometry: THREE.BufferGeometry,
    full: Uint16Array | Uint32Array,
  ) {
    if (!geometry.userData.compactIndex) return;
    const index = geometry.index!;
    (index.array as Uint16Array | Uint32Array).set(full);
    index.needsUpdate = true;
    geometry.setDrawRange(0, Infinity);
    geometry.userData.compactIndex = false;
  }

  // TODO: Deduplicate with other white values (LODManager, MaterialManager)
  private readonly white = 0xffffffff;

  private cleanAttributeMemory(geometry: THREE.BufferGeometry, name: string) {
    const attr = geometry.attributes[name] as THREE.BufferAttribute;
    attr.onUpload(this.deleteAttribute(geometry));
  }

  private setPositions(positions: any, geometry: THREE.BufferGeometry) {
    if (!positions) {
      throw new Error("Fragments: no positions provided to create the mesh.");
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.cleanAttributeMemory(geometry, "position");
  }

  private setFaceIds(faceIds: any, geometry: THREE.BufferGeometry) {
    if (faceIds) {
      geometry.setAttribute("color", new THREE.BufferAttribute(faceIds, 3));
      this.cleanAttributeMemory(geometry, "color");
    }
  }

  private setIndex(geometry: THREE.BufferGeometry, indices: any) {
    if (!indices) {
      throw new Error("Fragments: no indices provided to create the mesh.");
    }
    // Unlike positions/normals, the index array is kept on the CPU: it is
    // the source for compacting the visible ranges of a tile into a
    // single draw call (see applyCompactIndex). The GPU-side attribute is
    // a same-sized copy whose content is rewritten in place, so the GL
    // buffer never has to be reallocated.
    const full = indices as Uint16Array | Uint32Array;
    const gpu = full.slice();
    geometry.setIndex(new THREE.BufferAttribute(gpu, 1));
    geometry.userData.fullIndex = full;
    geometry.userData.compactIndex = false;
  }

  private setNormals(normals: any, geometry: THREE.BufferGeometry) {
    if (normals) {
      geometry.setAttribute(
        "normal",
        new THREE.BufferAttribute(normals, 3, true),
      );
    }
    this.cleanAttributeMemory(geometry, "normal");
  }

  private setItemIds(itemIds: any, geometry: THREE.BufferGeometry) {
    if (itemIds) {
      // 4 bytes per vertex (the four bytes of the localId, big-
      // endian). Bound as `vec4` so the picker shader can pass
      // them straight to `gl_FragColor` and decode the full uint32
      // at the readback step.
      geometry.setAttribute("id", new THREE.BufferAttribute(itemIds, 4, false));
      this.cleanAttributeMemory(geometry, "id");
    }
  }

  private deleteAttribute(_geometry: THREE.BufferGeometry) {
    function callback(this: any) {
      delete this.array;
    }
    return callback;
  }

  private setMeshData(mesh: BIMMesh, tileId: any, itemId: any, matrix: any) {
    mesh.userData = { tileId, itemId };
    mesh.matrixAutoUpdate = false;
    mesh.applyMatrix4(matrix);
    mesh.matrix.copy(matrix);
    // We own `matrix` (matrixAutoUpdate is off), so we must say its world
    // matrix is stale: since three r185, `updateWorldMatrix()` skips objects
    // without this flag, and getWorldPosition, Box3.setFromObject, attach...
    // would read the identity until the next render (#309).
    mesh.matrixWorldNeedsUpdate = true;
    mesh.updateWorldMatrix = updateTileWorldMatrix;
  }
}
