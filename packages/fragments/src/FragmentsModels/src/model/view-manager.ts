import * as THREE from "three";
import { RefreshViewRequest, RenderView } from "../multithreading/protocol";
import { LodMode, MultiThreadingRequestClass } from "./model-types";
import { FragmentsModel } from "./fragments-model";
import { MeshManager } from "./mesh-manager";
import { CameraUtils, GPU } from "../utils";

export class ViewManager {
  /**
   * Returns the planes to clip against. Read on every view refresh, so it
   * may return an array that the caller mutates in place.
   */
  getClippingPlanesEvent: () => THREE.Plane[] = () => [];

  currentCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null =
    null;

  private _viewSize: number | null = null;
  private _noCameraWarned = false;
  private readonly _tempMatrix = new THREE.Matrix4();
  private readonly _tempVec = new THREE.Vector3();
  private readonly _tempFrustum = new THREE.Frustum();

  /**
   * Numeric fingerprint of the last view dispatched to the worker.
   * `refreshView` skips the REFRESH_VIEW RPC when the view is
   * identical to the previous one (unless forced), so an idle camera
   * produces zero worker traffic instead of a full re-cull of every
   * sample on every update tick. See {@link refreshView}.
   */
  private _lastViewSignature: number[] | null = null;

  private _updateCameraPositionEvent: (vector: THREE.Vector3) => void =
    () => {};

  private _updateCameraFrustumEvent: (frustum: THREE.Frustum) => void =
    () => {};

  private _updateFOVEvent: () => number | void = () => {};

  private _updateOrthoSizeEvent: () => number | void = () => {};

  /**
   * Sends the current view to the worker so it can re-evaluate culling
   * and LOD. Returns `true` if a REFRESH_VIEW was actually dispatched.
   *
   * When `force` is false and the view (camera frustum + position in
   * model space, clipping planes, viewport size, quality, model
   * placement) is unchanged since the last dispatch, the RPC is
   * skipped entirely and `false` is returned. Visibility, highlight,
   * LOD-mode and edit changes don't need a view resend — the worker
   * restarts its own tile pass for those. Forced sends always go
   * through because `FragmentsModels.update(true)` uses the resulting
   * FINISH as a completion fence.
   */
  async refreshView(model: FragmentsModel, meshes: MeshManager, force = false) {
    const fov = this.setup(model);
    let frustum: THREE.Frustum;
    // With no camera there is nothing to cull against, so send a frustum
    // sized to the model rather than the default one, whose six identical
    // planes silently discard the negative-X half space (#255).
    if (!this.currentCamera) {
      this.warnNoCameraOnce(model);
      // `box` is world space; `_tempMatrix` is the inverse model matrix,
      // so this lands in the model space the worker culls in.
      const bounds = model.box;
      if (!bounds.isEmpty()) {
        bounds.applyMatrix4(this._tempMatrix);
      }
      frustum = CameraUtils.containing(bounds, this._tempFrustum);
    } else {
      frustum = CameraUtils.transform(this._tempFrustum, this._tempMatrix);
    }
    const request = this.newViewRequest(frustum, fov, model, 0);
    const signature = this.computeViewSignature(request.view, model);
    if (!force && this.signatureEquals(signature)) {
      return false;
    }
    const revision = meshes.beginViewUpdate(model);
    request.view.renderRevision = revision;
    meshes.requests.clean(model.modelId);
    this._lastViewSignature = signature;
    try {
      await model.threads.fetch(request);
      return true;
    } catch (error) {
      if (this._lastViewSignature === signature) this._lastViewSignature = null;
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

  private setup(model: FragmentsModel) {
    this._tempMatrix.copy(model.object.matrixWorld).invert();
    this._updateCameraPositionEvent(this._tempVec);
    this._updateCameraFrustumEvent(this._tempFrustum);
    const fov = this._updateFOVEvent();
    return fov;
  }

  private warnNoCameraOnce(model: FragmentsModel) {
    if (this._noCameraWarned) {
      return;
    }
    console.warn(
      `Fragments: model "${model.modelId}" is being rendered before ` +
        "useCamera() has been called. Frustum culling is disabled until " +
        "a camera is set.",
    );
    this._noCameraWarned = true;
  }

  /**
   * Flattens everything view-relevant into a number list for cheap
   * equality checks. `graphicThreshold` is deliberately excluded: it
   * only budgets the worker's invisible-tile cache, so a change in it
   * (e.g. the worker count changed) shouldn't force a full re-cull.
   * `undefined` fields (fov on ortho cameras, ortho size on
   * perspective ones) are encoded as NaN and compared with
   * `Object.is` semantics below.
   */
  private computeViewSignature(view: any, model: FragmentsModel) {
    const signature: number[] = [];
    const frustum = view.cameraFrustum as THREE.Frustum;
    for (const plane of frustum.planes) {
      signature.push(plane.normal.x, plane.normal.y, plane.normal.z);
      signature.push(plane.constant);
    }
    const position = view.cameraPosition as THREE.Vector3;
    signature.push(position.x, position.y, position.z);
    signature.push(view.fov ?? NaN);
    signature.push(view.orthogonalDimension ?? NaN);
    signature.push(view.viewSize);
    signature.push(view.graphicQuality);
    for (const plane of view.clippingPlanes as THREE.Plane[]) {
      signature.push(plane.normal.x, plane.normal.y, plane.normal.z);
      signature.push(plane.constant);
    }
    for (const element of model.object.matrixWorld.elements) {
      signature.push(element);
    }
    return signature;
  }

  private signatureEquals(signature: number[]) {
    const last = this._lastViewSignature;
    if (!last || last.length !== signature.length) {
      return false;
    }
    for (let i = 0; i < signature.length; i++) {
      // NaN encodes "undefined" — treat NaN === NaN as equal.
      if (
        signature[i] !== last[i] &&
        !(Number.isNaN(signature[i]) && Number.isNaN(last[i]))
      ) {
        return false;
      }
    }
    return true;
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
      graphicThreshold:
        GPU.estimateCapacity() / Math.max(1, model.threads.activeThreadCount),
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
