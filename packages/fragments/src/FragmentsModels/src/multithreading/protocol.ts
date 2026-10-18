import type * as THREE from "three";
import {
  CurrentLod,
  DataBuffer,
  MultiThreadingRequestClass,
  ObjectClass,
  TileRequestClass,
} from "../model/model-types";

// Bump when either side changes the wire contract incompatibly. Both entry
// points build this module; a separately hosted worker must match at runtime.
export const FRAGMENTS_PROTOCOL_VERSION = 4;
export const PROTOCOL_HANDSHAKE_TIMEOUT = 10_000;

export interface ProtocolHello {
  fragmentsProtocol: number;
}

export interface RenderView {
  renderRevision: number;
  cameraFrustum: THREE.Frustum | null;
  cameraPosition: THREE.Vector3;
  clippingPlanes: THREE.Plane[];
  modelPlacement: THREE.Matrix4;
  fov: number | void;
  orthogonalDimension: number | void;
  viewSize: number;
  graphicQuality: number;
  meshThreshold?: number;
}

export type WireVector = Pick<THREE.Vector3, "x" | "y" | "z">;
export type WirePlane = { normal: WireVector; constant: number };
export type WireFrustum = { planes: WirePlane[] };
export type WireMatrix = Pick<THREE.Matrix4, "elements">;

export type RenderViewMessage = Omit<
  RenderView,
  "cameraFrustum" | "cameraPosition" | "clippingPlanes" | "modelPlacement"
> & {
  cameraFrustum: WireFrustum | null;
  cameraPosition: WireVector;
  clippingPlanes: WirePlane[];
  modelPlacement: WireMatrix;
};

export interface RefreshViewRequest {
  class: MultiThreadingRequestClass.REFRESH_VIEW;
  modelId: string;
  view: RenderViewMessage;
}

interface TileRanges {
  position: Uint32Array;
  size: Uint32Array;
}

export interface TileRenderData {
  /** Unique internal item IDs in this tile's active draw ranges, not picker bytes. */
  visibleItemIds: Uint32Array;
  visibilityData?: TileRanges;
  highlightData?: TileRanges;
  highlightIds?: Uint32Array;
}

export interface TileIndexUpdate {
  /** Offset in the tile's complete index buffer, before visibility compaction. */
  start: number;
  indices: Uint16Array;
}

interface TileUpdate {
  tileRequestClass: TileRequestClass.UPDATE;
  modelId: string;
  tileId: number;
  objectClass: ObjectClass;
  material?: number;
  currentLod?: CurrentLod;
  tileData: TileRenderData;
  indexUpdates?: TileIndexUpdate[];
}

export interface TileCreate extends Omit<TileUpdate, "tileRequestClass"> {
  tileRequestClass: TileRequestClass.CREATE;
  itemId?: number;
  positions?: DataBuffer;
  indices?: DataBuffer;
  normals?: DataBuffer;
  itemIds?: DataBuffer;
  faceIds: Float32Array;
  matrix: WireMatrix;
  aabb: { min: WireVector; max: WireVector };
}

export type TileRequest =
  | TileCreate
  | TileUpdate
  | {
      tileRequestClass: TileRequestClass.DELETE;
      modelId: string;
      tileId: number;
    }
  | {
      tileRequestClass: TileRequestClass.FINISH;
      modelId: string;
      renderRevision: number;
      error?: string;
    };

export interface MeshComputeRequest {
  class: MultiThreadingRequestClass.RECOMPUTE_MESHES;
  modelId: string;
  list: TileRequest[];
}
