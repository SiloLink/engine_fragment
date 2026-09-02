import { AnyTileBasicData, TileBasicData } from "../types";
import { ObjectClass } from "../../../model/model-types";
import { Shell } from "../../../../../Schema";
import { ShellUtils } from "./shell-utils";
import {
  getShellTriangleCount,
  ShellChunkBoundary,
  ShellTopology,
  ShellVertexIndexer,
} from "./shell-topology";

export class ShellTemplateConstructor {
  private readonly _topology = new ShellTopology();
  private readonly _vertices = new ShellVertexIndexer();
  private readonly _chunkBoundary = new ShellChunkBoundary();
  private _triangleAmount = 0;
  private _meshes?: AnyTileBasicData;

  newMeshTemplate(shell: Shell) {
    const isEmpty = ShellUtils.getProfilesLength(shell) === 0;
    if (isEmpty) return { objectClass: ObjectClass.SHELL };
    this.reset(true);
    this._topology.setup(shell);
    const count = ShellUtils.getProfilesLength(shell);
    for (let profileId = 0; profileId < count; profileId++) {
      const profileStartVertexCount = this._vertices.size;
      let profile = this._topology.get(profileId, this._vertices, false);
      if (
        this._chunkBoundary.shouldStartNewChunk(
          profileStartVertexCount,
          this._vertices.size,
        )
      ) {
        this._vertices.rollback(profileStartVertexCount);
        this.setMesh();
        profile = this._topology.get(profileId, this._vertices, false);
        this._chunkBoundary.assertProfileFits(this._vertices.size);
      }
      this._triangleAmount += getShellTriangleCount(profile);
    }
    if (this.hasData()) this.setMesh();
    const result = this._meshes as TileBasicData;
    this._meshes = undefined;
    return result;
  }

  private hasData() {
    return this._triangleAmount > 0 || this._vertices.size > 0;
  }

  private setMesh() {
    const attributeCount = this._vertices.size * 3;
    const mesh: TileBasicData = {
      objectClass: ObjectClass.SHELL,
      indexCount: this._triangleAmount * 3,
      positionCount: attributeCount,
      normalCount: attributeCount,
    };
    if (!this._meshes) {
      this._meshes = mesh;
    } else if (Array.isArray(this._meshes)) {
      this._meshes.push(mesh);
    } else {
      this._meshes = [this._meshes, mesh];
    }
    this.reset(false);
  }

  private reset(evenMeshes: boolean) {
    this._vertices.reset();
    this._triangleAmount = 0;
    if (evenMeshes) this._meshes = undefined;
  }
}
