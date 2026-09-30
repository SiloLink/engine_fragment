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

  /**
   * Callback function to be invoked when a request with
   * `TileRequestClass.FINISH` is added, so its preceding tile changes
   * can be drained before the corresponding view is marked complete.
   */
  onFinish: () => void = () => {};

  async handleRequest(meshes: MeshManager, request: any) {
    if (request.class === MultiThreadingRequestClass.RECOMPUTE_MESHES) {
      this.add(request.list);
      request.list = undefined;
    } else if (request.class === MultiThreadingRequestClass.CREATE_MATERIAL) {
      const { materialDefinitions, modelId } = request;
      MaterialManager.resetColors(materialDefinitions);
      meshes.materials.addDefinitions(modelId, materialDefinitions);
      request.materialDefinitions = undefined;
    } else if (request.class === MultiThreadingRequestClass.THROW_ERROR) {
      console.error(request);
    }
  }

  /**
   * Adds an array of requests to the list. If a request with `TileRequestClass.FINISH` is added,
   * the `onFinishRequest` callback is invoked.
   *
   * @param requests - Array of requests to be added.
   */
  add(requests: TileRequest[]) {
    for (const request of requests) {
      if (!this.insert(request)) this.list.push(request);
      if (request.tileRequestClass === TileRequestClass.FINISH) {
        this.onFinish();
      }
    }
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
      const list = this.list.filter(
        (request) =>
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
      const list = this.list.filter(
        (request) =>
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
        )
          overriddenRequest.tileData = request.tileData;
        return true;
      }
    }

    return false;
  }

  private findLatestTileRequest(modelId: string, tileId: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const request = this.list[i];
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
