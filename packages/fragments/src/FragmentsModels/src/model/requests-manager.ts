import { TileRequest } from "../multithreading/protocol";
import { MultiThreadingRequestClass, TileRequestClass } from "./model-types";
import { MaterialManager } from "./material-manager";
import { MeshManager } from "./mesh-manager";

/**
 * Manages a list of requests for the MeshManager.
 */
export class RequestsManager {
  /**
   * List of requests.
   */
  list: TileRequest[] = [];

  /**
   * Checks if there are any pending requests.
   *
   * @returns `true` if there are pending requests, otherwise `false`.
   */
  get arePending() {
    return this.list.length > 0;
  }

  /** Called once after an incoming batch has been enqueued. */
  onPending: () => void = () => {};

  private _disposed = false;

  async handleRequest(meshes: MeshManager, request: any) {
    if (this._disposed) return;
    if (request.class === MultiThreadingRequestClass.RECOMPUTE_MESHES) {
      this.add(request.list);
      request.list = undefined;
    } else if (request.class === MultiThreadingRequestClass.CREATE_MATERIAL) {
      const { materialDefinitions, modelId, firstId } = request;
      MaterialManager.resetColors(materialDefinitions);
      meshes.materials.addDefinitions(modelId, materialDefinitions, firstId);
      request.materialDefinitions = undefined;
    } else if (request.class === MultiThreadingRequestClass.THROW_ERROR) {
      console.error(request);
    }
  }

  /**
   * Adds an entire batch before notifying the consumer. FINISH is an ordered
   * queue entry, not a request to synchronously flush preceding changes.
   *
   * @param requests - Array of requests to be added.
   */
  add(requests: TileRequest[]) {
    if (this._disposed) return;
    for (const request of requests) {
      if (!this.insert(request)) this.list.push(request);
    }
    if (this.arePending) this.onPending();
  }

  /** Discards queued changes belonging to a removed or failed model. */
  clear(modelId?: string) {
    this.list =
      modelId === undefined
        ? []
        : this.list.filter((request) => request.modelId !== modelId);
  }

  dispose() {
    this._disposed = true;
    this.clear();
    this.onPending = () => {};
  }

  /**
   * Cleans the list by removing requests with the specified model ID and `TileRequestClass.FINISH`.
   *
   * @param modelID - The model ID to filter requests by.
   */
  clean(modelID: string) {
    const list = this.list.filter(
      (request) =>
        request.modelId !== modelID ||
        request.tileRequestClass !== TileRequestClass.FINISH,
    );
    this.list = list;
  }

  /**
   * Inserts a request into the list based on its `tileRequestClass`.
   *
   * @param request - The request to be inserted.
   * @returns `true` if the request was successfully inserted, otherwise `false`.
   */
  insert(request: TileRequest) {
    if (request.tileRequestClass === TileRequestClass.FINISH) return false;
    const { modelId, tileId, tileRequestClass } = request;

    if (tileRequestClass === TileRequestClass.DELETE) {
      const boundary = this.findLastFinish(modelId);
      const list = this.list.filter(
        (request, index) =>
          index <= boundary ||
          !(
            (request.tileRequestClass === TileRequestClass.CREATE ||
              request.tileRequestClass === TileRequestClass.DELETE) &&
            request.modelId === modelId &&
            request.tileId === tileId
          ),
      );
      this.list = list;
    }

    if (tileRequestClass === TileRequestClass.CREATE) {
      const boundary = this.findLastFinish(modelId);
      const list = this.list.filter(
        (request, index) =>
          index <= boundary ||
          !(
            request.tileRequestClass === TileRequestClass.CREATE &&
            request.modelId === modelId &&
            request.tileId === tileId
          ),
      );
      this.list = list;
    }

    if (tileRequestClass === TileRequestClass.UPDATE) {
      // Only the latest queued change of the tile can receive the new state:
      // a rebuild queues DELETE then CREATE, and that CREATE must not keep
      // stale data. A trailing DELETE leaves no tile to update.
      const overriddenRequest = this.findLatestTileRequest(modelId, tileId);
      if (overriddenRequest) {
        if (
          overriddenRequest.tileRequestClass === TileRequestClass.CREATE ||
          overriddenRequest.tileRequestClass === TileRequestClass.UPDATE
        ) {
          overriddenRequest.tileData = request.tileData;
          if (request.indexUpdates?.length) {
            // Each chunk has a stable full-index offset. Preserve untouched
            // chunks while retaining only the latest order of a changed one.
            const updates = new Map(
              (overriddenRequest.indexUpdates ?? []).map((entry) => [
                entry.start,
                entry,
              ]),
            );
            for (const entry of request.indexUpdates) {
              updates.set(entry.start, entry);
            }
            overriddenRequest.indexUpdates = [...updates.values()];
          }
        }
        return true;
      }
    }

    return false;
  }

  private findLastFinish(modelId: string) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const request = this.list[i];
      if (
        request.modelId === modelId &&
        request.tileRequestClass === TileRequestClass.FINISH
      )
        return i;
    }
    return -1;
  }

  private findLatestTileRequest(modelId: string, tileId: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const request = this.list[i];
      if (
        request.modelId === modelId &&
        request.tileRequestClass === TileRequestClass.FINISH
      )
        return undefined;
      if (
        request.tileRequestClass !== TileRequestClass.FINISH &&
        request.modelId === modelId &&
        request.tileId === tileId
      ) {
        return request;
      }
    }
    return undefined;
  }
}
