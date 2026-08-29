import * as THREE from "three";
import { Shell } from "../../../../../Schema";
import { FaceUtils } from "../../../utils";
// @ts-ignore earcut is a local callback-based fork.
import { earcut } from "../../../utils/geometry/earcut";
import { AnyTileData, TileData } from "../types";
import {
  ShellChunkBoundary,
  ShellContour,
  ShellTopology,
  ShellTopologyProfile,
  ShellVertexIndexer,
} from "./shell-topology";
import { ShellUtils } from "./shell-utils";

export class ShellConstructor {
  private readonly _topology = new ShellTopology();
  private readonly _vertices = new ShellVertexIndexer();
  private readonly _chunkBoundary = new ShellChunkBoundary();
  private readonly _faceIdPerProfile = new Map<number, number>();
  private readonly _quad = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  private readonly _edgeA = new THREE.Vector3();
  private readonly _edgeB = new THREE.Vector3();
  private readonly _edgeC = new THREE.Vector3();
  private readonly _crossA = new THREE.Vector3();
  private readonly _crossB = new THREE.Vector3();
  private readonly _polygonNormal = new THREE.Vector3();
  private _tileData!: TileData;
  private _tileIndex = 0;
  private _indexOffset = 0;

  construct(shell: Shell, meshData: TileData | TileData[]) {
    this._topology.setup(shell);
    this.getFaceIds(shell);
    this._tileIndex = 0;
    this.startBuffer(meshData);

    const points = ShellUtils.getBuffer(shell);
    const count = ShellUtils.getProfilesLength(shell);
    for (let profileId = 0; profileId < count; profileId++) {
      const profile = this._topology.get(profileId, this._vertices, true);
      this.constructProfile(profile, points);
      const chunkComplete = this._chunkBoundary.add(profile);
      if (chunkComplete && profileId + 1 < count) {
        this.finishBuffer(points);
        this._tileIndex++;
        this.startBuffer(meshData);
      }
    }

    this.finishBuffer(points);
    this._tileData = undefined as any;
  }

  private constructProfile(
    profile: ShellTopologyProfile,
    points: Float32Array,
  ) {
    const hasHoles = profile.holes.length > 0;
    const outerVertexIds = profile.outer.vertexIds!;
    if (profile.outer.pointIds.length === 3 && !hasHoles) {
      this.emitTriangle(
        outerVertexIds[0],
        outerVertexIds[1],
        outerVertexIds[2],
      );
      return;
    }

    if (
      profile.outer.pointIds.length === 4 &&
      !hasHoles &&
      this.isConvexQuad(profile.outer.pointIds, points)
    ) {
      this.emitTriangle(
        outerVertexIds[0],
        outerVertexIds[1],
        outerVertexIds[3],
      );
      this.emitTriangle(
        outerVertexIds[3],
        outerVertexIds[1],
        outerVertexIds[2],
      );
      return;
    }

    this.constructPolygon(profile, points);
  }

  private constructPolygon(
    profile: ShellTopologyProfile,
    points: Float32Array,
  ) {
    let pointCount = profile.outer.pointIds.length;
    for (const hole of profile.holes) pointCount += hole.pointIds.length;

    const positions = new Float32Array(pointCount * 3);
    const vertexIds = new Uint16Array(pointCount);
    let pointOffset = 0;
    const copyContour = (contour: ShellContour) => {
      const contourVertexIds = contour.vertexIds!;
      for (let index = 0; index < contour.pointIds.length; index++) {
        const sourceOffset = contour.pointIds[index] * 3;
        const targetOffset = pointOffset * 3;
        positions[targetOffset] = points[sourceOffset];
        positions[targetOffset + 1] = points[sourceOffset + 1];
        positions[targetOffset + 2] = points[sourceOffset + 2];
        vertexIds[pointOffset] = contourVertexIds[index];
        pointOffset++;
      }
    };

    copyContour(profile.outer);
    for (const hole of profile.holes) {
      copyContour(hole);
    }

    const holeStarts: number[] = [];
    let holeOffset = profile.outer.pointIds.length;
    for (const hole of profile.holes) {
      holeStarts.push(holeOffset);
      holeOffset += hole.pointIds.length;
    }

    this.computePolygonNormal(positions, profile.outer.pointIds.length);
    const dimensions = FaceUtils.getEarcutDimensions(this._polygonNormal);
    earcut(
      positions,
      holeStarts.length > 0 ? holeStarts : undefined,
      3,
      dimensions[0],
      dimensions[1],
      (first: number, second: number, third: number) => {
        this.emitTriangle(
          vertexIds[first],
          vertexIds[second],
          vertexIds[third],
        );
      },
    );
  }

  private computePolygonNormal(positions: Float32Array, count: number) {
    this._polygonNormal.set(0, 0, 0);
    for (let index = 0; index < count; index++) {
      const next = (index + 1) % count;
      const currentOffset = index * 3;
      const nextOffset = next * 3;
      const x1 = positions[currentOffset];
      const x2 = positions[nextOffset];
      const y1 = positions[currentOffset + 1];
      const y2 = positions[nextOffset + 1];
      const z1 = positions[currentOffset + 2];
      const z2 = positions[nextOffset + 2];
      this._polygonNormal.x += (y1 - y2) * (z1 + z2);
      this._polygonNormal.y += (z1 - z2) * (x1 + x2);
      this._polygonNormal.z += (x1 - x2) * (y1 + y2);
    }
    this._polygonNormal.normalize();
  }

  private isConvexQuad(
    pointIds: Uint16Array | Uint32Array,
    points: Float32Array,
  ) {
    for (let index = 0; index < 4; index++) {
      const offset = pointIds[index] * 3;
      this._quad[index].set(
        points[offset],
        points[offset + 1],
        points[offset + 2],
      );
    }
    this._edgeA.copy(this._quad[1]).sub(this._quad[0]);
    this._edgeB.copy(this._quad[2]).sub(this._quad[0]);
    this._edgeC.copy(this._quad[3]).sub(this._quad[0]);
    this._crossA.crossVectors(this._edgeA, this._edgeB);
    this._crossB.crossVectors(this._edgeB, this._edgeC);
    return this._crossA.dot(this._crossB) > 0;
  }

  private emitTriangle(first: number, second: number, third: number) {
    const indices = this._tileData.indexBuffer!;
    indices[this._indexOffset++] = first;
    indices[this._indexOffset++] = second;
    indices[this._indexOffset++] = third;
  }

  private startBuffer(bufferGeometries: AnyTileData) {
    if (Array.isArray(bufferGeometries)) {
      this._tileData = bufferGeometries[this._tileIndex];
    } else {
      this._tileData = bufferGeometries;
    }
    this._tileData.indexBuffer = new Uint16Array(this._tileData.indexCount!);
    this._tileData.positionBuffer = new Float32Array(
      this._tileData.positionCount!,
    );
    this._tileData.normalBuffer = new Int16Array(this._tileData.normalCount!);
    this._tileData.faceIdBuffer = new Uint32Array(
      this._tileData.positionCount! / 3,
    );
    this._vertices.reset();
    this._chunkBoundary.reset();
    this._indexOffset = 0;
  }

  private finishBuffer(points: Float32Array) {
    const positions = this._tileData.positionBuffer!;
    const normals = this._tileData.normalBuffer!;
    const faceIds = this._tileData.faceIdBuffer!;
    for (let index = 0; index < this._vertices.vertices.length; index++) {
      const vertex = this._vertices.vertices[index];
      const sourceOffset = vertex.pointId * 3;
      const targetOffset = index * 3;
      positions[targetOffset] = points[sourceOffset];
      positions[targetOffset + 1] = points[sourceOffset + 1];
      positions[targetOffset + 2] = points[sourceOffset + 2];
      normals[targetOffset] = vertex.normalX;
      normals[targetOffset + 1] = vertex.normalY;
      normals[targetOffset + 2] = vertex.normalZ;
      faceIds[index] = this._faceIdPerProfile.get(vertex.profileId)!;
    }
  }

  private getNextFaceId() {
    const maxUint32 = 4294967295;
    return Math.random() * maxUint32;
  }

  private getFaceIds(shell: Shell) {
    this._faceIdPerProfile.clear();
    const faceIds = shell.profilesFaceIdsArray();
    const colors = new Map<number, number>();
    if (faceIds && faceIds.length > 0) {
      for (let profileId = 0; profileId < faceIds.length; profileId++) {
        const rawFaceId = faceIds[profileId];
        if (!colors.has(rawFaceId)) {
          colors.set(rawFaceId, this.getNextFaceId());
        }
        this._faceIdPerProfile.set(profileId, colors.get(rawFaceId)!);
      }
      return;
    }

    const count = ShellUtils.getProfilesLength(shell);
    for (let profileId = 0; profileId < count; profileId++) {
      this._faceIdPerProfile.set(profileId, this.getNextFaceId());
    }
  }
}
