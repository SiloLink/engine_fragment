import * as THREE from "three";
import { TileIndexUpdate, TileRequest } from "../multithreading/protocol";
import { MaterialManager } from "./material-manager";
import {
  TileRequestClass,
  ObjectClass,
  CurrentLod,
  BIMMesh,
  CompactIndexRuns,
} from "./model-types";
import { FragmentsModel } from "./fragments-model";
import { DataMap } from "../../../Utils";
import { RequestsManager } from "./requests-manager";
import { LODManager } from "./lod-manager";
import { LODMesh } from "../lod";
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
  private _idleWaiters: {
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  private readonly _modelInstances = new Map<string, FragmentsModel>();
  private readonly _applicationFailures = new Map<FragmentsModel, unknown>();
  private readonly _visibleItemCounts = new WeakMap<
    FragmentsModel,
    Map<number, number>
  >();
  private _updateTimer: ReturnType<typeof setTimeout> | null = null;
  private _updating = false;
  private _disposed = false;

  private _onUpdate: () => void;

  constructor(onUpdate: () => void) {
    this._onUpdate = onUpdate;
    this.requests.onPending = () => this.scheduleUpdate();
    this.list.onItemSet.add(({ key, value }) => {
      this._modelInstances.set(key, value);
    });
    this.list.onItemDeleted.add((key) => {
      const model = this._modelInstances.get(key);
      if (model) {
        this._applicationFailures.delete(model);
        this.clearVisibleItems(model);
      }
      this._modelInstances.delete(key);
      this.removeRequests(key);
      this.settleViewFences();
    });
    this.list.onItemUpdated.add(({ key, value }) => {
      const previous = this._modelInstances.get(key);
      if (previous !== value) {
        if (previous) {
          this._applicationFailures.delete(previous);
          this.clearVisibleItems(previous);
        }
        this.removeRequests(key);
      }
      this._modelInstances.set(key, value);
      this.settleViewFences();
    });
    this.list.onCleared.add(() => {
      for (const model of this._modelInstances.values())
        this.clearVisibleItems(model);
      this._modelInstances.clear();
      this._applicationFailures.clear();
      this.requests.clear();
      this.cancelUpdate();
      this.settleViewFences();
      this.settleIdleWaiters();
    });
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
      this.scheduleUpdate();
      this.settleViewFences();
    });
  }

  private finishView(model: FragmentsModel, revision: number) {
    const state = this._views.get(model);
    if (
      !state ||
      !(revision >= state.firstRevision) ||
      (state.failure && state.failure.revision >= revision)
    )
      return;
    state.completed = Math.max(state.completed, revision);
    if (revision >= state.requested) model._finishProcessing();
    this.settleViewFences();
  }

  private settleViewFences() {
    this._fenceWaiters = this._fenceWaiters.filter((waiter) => {
      let pending = false;
      for (const { model, revision } of waiter.targets) {
        if (this._disposed || this.list.get(model.modelId) !== model) {
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
   * Applies one budgeted slice. Worker arrivals schedule this independently
   * of camera updates, including while a forced update awaits its FINISH.
   * Each task yields to the browser; an empty queue schedules no further work.
   */
  update() {
    if (this._disposed || this._updating) return;
    this.cancelUpdate();
    this._updating = true;
    const start = performance.now();
    let changed = false;
    try {
      while (this.requests.arePending && !this._disposed) {
        const request = this.requests.list.shift()!;
        try {
          changed = this.processTileRequest(request) || changed;
        } catch (cause) {
          const model = this.list.get(request.modelId);
          const state = model && this._views.get(model);
          // A failed DELETE can be lost from the worker's next delta. Retain
          // the failure until this model lifetime is removed; queue emptiness
          // alone must never acknowledge that its geometry was released.
          if (model) this._applicationFailures.set(model, cause);
          this.removeRequests(request.modelId);
          for (const waiter of this._idleWaiters.splice(0))
            waiter.reject(cause);
          if (model && state) {
            this.failViewUpdate(model, state.requested, cause);
          } else {
            throw cause;
          }
        }
        if (performance.now() - start >= this.updateThreshold) break;
      }
    } finally {
      this._updating = false;
      this.scheduleUpdate();
      if (changed && !this._disposed) this._onUpdate();
      this.settleIdleWaiters();
    }
  }

  /**
   * Waits for queued changes to be applied without requesting another view.
   * Producers must flush their messages before calling this; future arrivals
   * after the queue becomes idle are not part of this wait.
   */
  whenIdle(): Promise<void> {
    if (this._disposed) {
      return Promise.reject(new Error("Fragments: mesh manager is disposed."));
    }
    const failure = this._applicationFailures.values().next();
    if (!failure.done) return Promise.reject(failure.value);
    if (!this._updating && !this.requests.arePending) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this._idleWaiters.push({ resolve, reject });
      this.scheduleUpdate();
    });
  }

  private settleIdleWaiters() {
    const failure = this._applicationFailures.values().next();
    if (!failure.done) {
      for (const waiter of this._idleWaiters.splice(0))
        waiter.reject(failure.value);
      return;
    }
    if (this._updating || this.requests.arePending) return;
    for (const waiter of this._idleWaiters.splice(0)) waiter.resolve();
  }

  /** Stops queue consumption and rejects waits before worker teardown. */
  dispose() {
    this._disposed = true;
    this.cancelUpdate();
    this.requests.dispose();
    for (const model of this._modelInstances.values())
      this.clearVisibleItems(model);
    this._modelInstances.clear();
    this._applicationFailures.clear();
    const error = new Error("Fragments: mesh manager is disposed.");
    for (const waiter of this._idleWaiters.splice(0)) waiter.reject(error);
    for (const waiter of this._fenceWaiters.splice(0)) {
      const target = waiter.targets[0];
      if (target) {
        waiter.reject(
          new ModelViewUpdateError(
            "model-removed",
            target.model.modelId,
            target.revision,
          ),
        );
      } else {
        waiter.resolve();
      }
    }
  }

  private scheduleUpdate() {
    if (
      this._disposed ||
      this._updating ||
      this._updateTimer !== null ||
      !this.requests.arePending
    )
      return;
    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      this.update();
    }, 0);
  }

  private cancelUpdate() {
    if (this._updateTimer === null) return;
    clearTimeout(this._updateTimer);
    this._updateTimer = null;
  }

  private removeRequests(modelId: string) {
    this.requests.clear(modelId);
    if (!this.requests.arePending) this.cancelUpdate();
    this.settleIdleWaiters();
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
    if (!model) return false;
    const state = this._views.get(model);
    if (
      tileRequestClass !== TileRequestClass.FINISH &&
      state?.failure &&
      state.failure.revision >= state.requested
    )
      return false;
    if (tileRequestClass === TileRequestClass.CREATE) {
      if (request.objectClass === undefined) return false;
      const tile = this.create(request);
      this.setTileData(tile, request);
      const previous = model.tiles.get(request.tileId);
      if (previous) this.releaseTileVisibility(model, previous);
      this.updateVisibleItems(model, tile, request.tileData.visibleItemIds);
      model.tiles.set(tile.userData.tileId, tile);
      return true;
    }
    if (tileRequestClass === TileRequestClass.DELETE) {
      return model.tiles.delete(request.tileId);
    }
    if (tileRequestClass === TileRequestClass.UPDATE) {
      const tileObject = model.tiles.get(request.tileId);
      if (tileObject) {
        this.updateStatus(tileObject, request);
        this.updateVisibleItems(
          model,
          tileObject,
          request.tileData.visibleItemIds,
        );
        return true;
      }
    } else if (tileRequestClass === TileRequestClass.FINISH) {
      if (request.error === undefined) {
        this.finishView(model, request.renderRevision);
      } else {
        this.failViewUpdate(model, request.renderRevision, request.error);
      }
    }
    return false;
  }

  private updateVisibleItems(
    model: FragmentsModel,
    tile: BIMMesh,
    itemIds: Uint32Array,
  ) {
    const next = new Set(itemIds);
    const previous = tile.userData.itemIds as Set<number> | undefined;
    let counts = this._visibleItemCounts.get(model);
    if (!counts) {
      counts = new Map();
      this._visibleItemCounts.set(model, counts);
    }
    for (const id of previous ?? []) {
      if (!next.has(id)) this.removeVisibleItem(model, counts, id);
    }
    for (const id of next) {
      if (previous?.has(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      model.visibleItems.add(id);
    }
    tile.userData.itemIds = next;
  }

  /** @internal Releases membership for both streamed and direct tile deletion. */
  releaseTileVisibility(model: FragmentsModel, tile: BIMMesh) {
    const counts = this._visibleItemCounts.get(model);
    const ids = tile.userData.itemIds as Set<number> | undefined;
    if (counts && ids) {
      for (const id of ids) this.removeVisibleItem(model, counts, id);
    }
    delete tile.userData.itemIds;
  }

  private removeVisibleItem(
    model: FragmentsModel,
    counts: Map<number, number>,
    id: number,
  ) {
    const count = counts.get(id)!;
    if (count > 1) counts.set(id, count - 1);
    else {
      counts.delete(id);
      model.visibleItems.delete(id);
    }
  }

  private clearVisibleItems(model: FragmentsModel) {
    if (!this._visibleItemCounts.has(model)) return;
    model.visibleItems.clear();
    this._visibleItemCounts.delete(model);
    for (const tile of model.tiles.values()) delete tile.userData.itemIds;
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
    this.updateIndices(geometry, request.indexUpdates);
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

  private updateIndices(
    geometry: THREE.BufferGeometry,
    updates: TileIndexUpdate[] | undefined,
  ) {
    if (!updates?.length) return;
    const full = geometry.userData.fullIndex as Uint16Array | Uint32Array;
    const index = geometry.index!;
    for (const { start, indices } of updates) {
      full.set(indices, start);
      if (index.array !== full && !geometry.userData.compactIndex) {
        (index.array as Uint16Array | Uint32Array).set(indices, start);
      }
    }
    // Keep the attribute and fullIndex objects stable: render proxies can
    // share either. Compaction below rebuilds its working array from full.
    index.needsUpdate = true;
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
   * The packing is published as `userData.compactRuns`, so renderers that
   * draw item chunks of the full index find them in the packed one.
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

    // Keep the full index immutable. Only tiles using compaction need a
    // writable copy. Reuse it for the tile's lifetime, including across
    // highlight/group updates, to avoid allocating on every transition.
    if (index.array === full) index.array = full.slice();
    const target = index.array as Uint16Array | Uint32Array;
    const { position, size } = visibilityData!;
    const packedStarts = new Uint32Array(runs);
    const packedCounts = new Uint32Array(runs);
    const packedOffsets = new Uint32Array(runs);
    let packed = 0;
    let count = 0;
    for (let i = 0; i < runs; i++) {
      const start = position[i];
      const isWhite = size[i] === this.white;
      const end = isWhite
        ? full.length
        : Math.min(full.length, start + size[i]);
      if (end <= start) continue;
      target.set(full.subarray(start, end), count);
      packedStarts[packed] = start;
      packedCounts[packed] = end - start;
      packedOffsets[packed] = count;
      packed++;
      count += end - start;
    }

    index.needsUpdate = true;
    geometry.setDrawRange(0, count);
    geometry.addGroup(0, count, 0);
    geometry.userData.compactIndex = true;
    const packing: CompactIndexRuns = {
      start: packedStarts.subarray(0, packed),
      count: packedCounts.subarray(0, packed),
      offset: packedOffsets.subarray(0, packed),
    };
    geometry.userData.compactRuns = packing;
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
    delete geometry.userData.compactRuns;
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
    // single draw call (see applyCompactIndex). The attribute shares this
    // array until compaction needs a writable copy of the same type and
    // length, so the GL buffer never has to be reallocated.
    const full = indices as Uint16Array | Uint32Array;
    geometry.setIndex(new THREE.BufferAttribute(full, 1));
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
