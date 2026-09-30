import * as THREE from "three";
import { RefreshViewRequest, RenderView } from "../multithreading/protocol";
import { LodMode, MultiThreadingRequestClass } from "./model-types";
import { FragmentsModel } from "./fragments-model";
import { MeshManager } from "./mesh-manager";
import { CameraUtils, GPU } from "../utils";

export class ViewManager {
  getClippingPlanesEvent: () => THREE.Plane[] = () => [];

  currentCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null =
    null;

  private _viewSize: number | null = null;
  private readonly _tempMatrix = new THREE.Matrix4();
  private readonly _tempVec = new THREE.Vector3();
  private readonly _tempFrustum = new THREE.Frustum();

  private _updateCameraPositionEvent: (vector: THREE.Vector3) => void =
    () => {};

  private _updateCameraFrustumEvent: (frustum: THREE.Frustum) => void =
    () => {};

  private _updateFOVEvent: () => number | void = () => {};

  private _updateOrthoSizeEvent: () => number | void = () => {};

  async refreshView(model: FragmentsModel, meshes: MeshManager) {
    const fov = this.setup(meshes, model);
    const frustum = CameraUtils.transform(this._tempFrustum, this._tempMatrix);
    const revision = meshes.beginViewUpdate(model);
    try {
      const request = this.newViewRequest(frustum, fov, model, revision);
      await model.threads.fetch(request);
    } catch (error) {
      throw meshes.failViewUpdate(model, revision, error);
    }
  }

  useCamera(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    viewSize?: number,
  ) {
    if (
      viewSize !== undefined &&
      (!Number.isFinite(viewSize) || viewSize <= 0)
    ) {
      throw new Error("viewSize must be a positive finite number");
    }
    this._viewSize = viewSize ?? null;
    const projScreenMatrix = new THREE.Matrix4();
    this.setCameraPosition(camera);
    this.setCameraFrustum(camera, projScreenMatrix);
    this.setFov(camera);
    this.setOrtho();
    this.currentCamera = camera;
  }

  async setLodMode(model: FragmentsModel, lodMode: LodMode) {
    return model.threads.invoke(model.modelId, "setLodMode", [
      lodMode,
    ]) as Promise<void>;
  }

  async setItemsGeometryPinned(
    model: FragmentsModel,
    localIds: number[],
    pinned: boolean,
  ) {
    return model.threads.invoke(model.modelId, "setItemsGeometryPinned", [
      localIds,
      pinned,
    ]) as Promise<void>;
  }

  private getOrthoSize() {
    let orthoSize = this._updateOrthoSizeEvent();
    if (orthoSize) {
      const modelScale = this._tempMatrix.getMaxScaleOnAxis();
      orthoSize *= modelScale;
    }
    return orthoSize;
  }

  private setup(meshes: MeshManager, model: FragmentsModel) {
    meshes.requests.clean(model.modelId);
    this._tempMatrix.copy(model.object.matrixWorld).invert();
    this._updateCameraPositionEvent(this._tempVec);
    this._updateCameraFrustumEvent(this._tempFrustum);
    const fov = this._updateFOVEvent();
    return fov;
  }

  private newViewRequest(
    frustum: THREE.Frustum,
    fov: number | void,
    model: FragmentsModel,
    renderRevision: number,
  ): RefreshViewRequest {
    return {
      class: MultiThreadingRequestClass.REFRESH_VIEW,
      modelId: model.modelId,
      view: this.newView(frustum, fov, model, renderRevision),
    };
  }

  private newView(
    frustum: THREE.Frustum,
    fov: number | void,
    model: FragmentsModel,
    renderRevision: number,
  ): RenderView {
    return {
      renderRevision,
      cameraFrustum: frustum,
      cameraPosition: this._tempVec.applyMatrix4(this._tempMatrix),
      fov,
      orthogonalDimension: this.getOrthoSize(),
      viewSize:
        this._viewSize ?? Math.max(window.innerWidth, window.innerHeight),
      graphicThreshold: GPU.estimateCapacity(),
      graphicQuality: model.graphicsQuality * -1.5 + 2,
      clippingPlanes: this.getPlanes(),
      modelPlacement: model.object.matrixWorld,
    };
  }

  private setOrtho() {
    // TODO: return ortho size in meters of biggest camera dimension (width or height)
    this._updateOrthoSizeEvent = () => {
      return undefined;
    };
  }

  private setFov(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    this._updateFOVEvent = () => {
      if (camera instanceof THREE.PerspectiveCamera) {
        return camera.fov;
      }
      return undefined;
    };
  }

  private getPlanes() {
    const planes: THREE.Plane[] = [];
    const originalPlanes = this.getClippingPlanesEvent();
    for (const plane of originalPlanes) {
      const cloned = plane.clone();
      cloned.applyMatrix4(this._tempMatrix);
      planes.push(cloned);
    }
    return planes;
  }

  private setCameraPosition(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  ) {
    this._updateCameraPositionEvent = (position: THREE.Vector3) => {
      position.copy(camera.position);
    };
  }

  private setCameraFrustum(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    projScreenMatrix: THREE.Matrix4,
  ) {
    this._updateCameraFrustumEvent = (frustum: THREE.Frustum) => {
      camera.updateProjectionMatrix();
      camera.updateWorldMatrix(true, true);
      const { projectionMatrix, matrixWorldInverse } = camera;
      projScreenMatrix.multiplyMatrices(projectionMatrix, matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreenMatrix);
    };
  }
}
