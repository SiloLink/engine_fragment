import * as THREE from "three";
import { ObjectClass, CurrentLod, DataBuffer } from "../../model/model-types";
import { MultiBufferData } from "../../utils";

export const normalizationValue = 2 ** 15 - 1;

export const enum LodClass {
  NONE = 0,
  AABB = 1,
  CUSTOM = 2,
}

export interface TileBasicData {
  objectClass: ObjectClass;
  indexCount?: number;
  positionCount?: number;
  normalCount?: number;
  lodThickness?: number;
  lod?: CurrentLod;
}

export type AnyTileBasicData = TileBasicData | TileBasicData[];

export interface TileSampleSpan {
  start: number;
  count: number;
}

export interface ShellRenderLayout {
  indices: Uint16Array;
  oldToNewVertex: Uint16Array;
}

export interface TileData extends TileBasicData {
  box: THREE.Box3;
  indexLocation: number[];
  vertexLocation: number[];
  sampleSpans: Map<number, TileSampleSpan>;
  geometriesLocation: number[];
  size: number;
  notVirtual: boolean;
  usedMemory?: number;
  materialId?: number;
  location?: THREE.Vector3;
  ids?: DataBuffer;
  indexBuffer?: DataBuffer;
  positionBuffer?: DataBuffer;
  faceIdBuffer?: DataBuffer;
  normalBuffer?: DataBuffer;
  renderLayout?: ShellRenderLayout;
  renderLayoutOpaqueBySample?: Map<number, boolean>;
  visibilities?: MultiBufferData<boolean>;
  highlights?: MultiBufferData<number>;
}

export type AnyTileData = TileData | TileData[];

export type VirtualTemplates = Map<number, AnyTileBasicData>;
