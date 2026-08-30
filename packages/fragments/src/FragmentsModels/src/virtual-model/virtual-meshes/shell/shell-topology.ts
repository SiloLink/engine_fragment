import {
  BigShellHole,
  BigShellProfile,
  Shell,
  ShellHole,
  ShellProfile,
  ShellType,
} from "../../../../../Schema";
import { limitOf2Bytes } from "../../../model/model-types";
import { ShellUtils } from "./shell-utils";

export interface ShellVertex {
  pointId: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  profileId: number;
  faceGroup: number;
}

export interface ShellContour {
  pointIds: Uint16Array | Uint32Array;
  vertexIds?: Uint16Array;
}

export interface ShellTopologyProfile {
  outer: ShellContour;
  holes: ShellContour[];
}

export class ShellVertexIndexer {
  readonly vertices: ShellVertex[] = [];
  private readonly _verticesByPoint = new Map<number, number[]>();

  get size() {
    return this.vertices.length;
  }

  reset() {
    this.vertices.length = 0;
    this._verticesByPoint.clear();
  }

  rollback(size: number) {
    for (let index = this.vertices.length - 1; index >= size; index--) {
      const vertex = this.vertices[index];
      const variants = this._verticesByPoint.get(vertex.pointId)!;
      variants.pop();
      if (variants.length === 0) this._verticesByPoint.delete(vertex.pointId);
    }
    this.vertices.length = size;
  }

  add(
    pointId: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    profileId: number,
    faceGroup: number,
  ) {
    let variants = this._verticesByPoint.get(pointId);
    if (!variants) {
      variants = [];
      this._verticesByPoint.set(pointId, variants);
    }

    for (const existing of variants) {
      const vertex = this.vertices[existing];
      if (
        vertex.normalX === normalX &&
        vertex.normalY === normalY &&
        vertex.normalZ === normalZ &&
        vertex.faceGroup === faceGroup
      ) {
        return existing;
      }
    }

    const index = this.vertices.length;
    this.vertices.push({
      pointId,
      normalX,
      normalY,
      normalZ,
      profileId,
      faceGroup,
    });
    variants.push(index);
    return index;
  }
}

export class ShellChunkBoundary {
  shouldStartNewChunk(
    currentVertexCount: number,
    candidateVertexCount: number,
  ) {
    if (candidateVertexCount <= limitOf2Bytes) return false;
    if (currentVertexCount === 0) {
      throw new Error(
        "Fragments: SHELL profile exceeds Uint16 vertex capacity.",
      );
    }
    return true;
  }
}

export function getShellTriangleCount(profile: ShellTopologyProfile) {
  if (profile.holes.length === 0) {
    return Math.max(0, profile.outer.pointIds.length - 2);
  }

  let corners = profile.outer.pointIds.length;
  for (const hole of profile.holes) corners += hole.pointIds.length;
  return corners + (profile.holes.length - 1) * 2;
}

export class ShellTopology {
  private readonly _shellHole = new ShellHole();
  private readonly _bigShellHole = new BigShellHole();
  private readonly _shellProfile = new ShellProfile();
  private readonly _bigShellProfile = new BigShellProfile();
  private readonly _holesByProfile = new Map<
    number,
    (Uint16Array | Uint32Array)[]
  >();
  private _faceGroups: Uint16Array | null = null;
  private readonly _faceNormals = [];
  private _pointsPerProfile = new Map<number, number[]>();
  private _shell!: Shell;

  setup(shell: Shell) {
    this._shell = shell;
    this._faceNormals.length = 0;
    ShellUtils.getNormalsOfShellProfile(shell, this._faceNormals);
    this._pointsPerProfile = ShellUtils.getPointsShell(shell);
    this._faceGroups = shell.profilesFaceIdsArray();
    this.setupHoles(shell);
  }

  get(
    profileId: number,
    vertices: ShellVertexIndexer,
    collectVertexIds: boolean,
  ): ShellTopologyProfile {
    const profile = this.getTempProfile();
    ShellUtils.getProfile(this._shell, profileId, profile);
    const outer = this.getContour(
      profile.indicesArray() ?? new Uint16Array(),
      profileId,
      vertices,
      collectVertexIds,
    );
    const holes = (this._holesByProfile.get(profileId) ?? []).map((indices) =>
      this.getContour(indices, profileId, vertices, collectVertexIds),
    );
    return { outer, holes };
  }

  private setupHoles(shell: Shell) {
    this._holesByProfile.clear();
    const hole = this.getTempHole();
    const count = ShellUtils.getHolesLength(shell);
    for (let holeId = 0; holeId < count; holeId++) {
      ShellUtils.getHole(shell, holeId, hole);
      const profileId = hole.profileId();
      let holes = this._holesByProfile.get(profileId);
      if (!holes) {
        holes = [];
        this._holesByProfile.set(profileId, holes);
      }
      holes.push(hole.indicesArray() ?? new Uint16Array());
    }
  }

  private getContour(
    pointIds: Uint16Array | Uint32Array,
    profileId: number,
    vertices: ShellVertexIndexer,
    collectVertexIds: boolean,
  ): ShellContour {
    const normals = ShellUtils.computeNormalsAvg(
      pointIds,
      profileId,
      this._faceNormals,
      this._pointsPerProfile,
    );
    const faceGroup =
      this._faceGroups && this._faceGroups.length > 0
        ? this._faceGroups[profileId]
        : profileId;
    const vertexIds = collectVertexIds
      ? new Uint16Array(pointIds.length)
      : undefined;

    for (let index = 0; index < pointIds.length; index++) {
      const normalOffset = index * 3;
      const vertexId = vertices.add(
        pointIds[index],
        normals[normalOffset],
        normals[normalOffset + 1],
        normals[normalOffset + 2],
        profileId,
        faceGroup,
      );
      if (vertexIds) vertexIds[index] = vertexId;
    }
    return { pointIds, vertexIds };
  }

  private getTempProfile() {
    if (this._shell.type() === ShellType.BIG) return this._bigShellProfile;
    return this._shellProfile;
  }

  private getTempHole() {
    if (this._shell.type() === ShellType.BIG) return this._bigShellHole;
    return this._shellHole;
  }
}
