import * as THREE from "three";
import { LODGeometry, LODMesh } from "../lod";
import { LodHelper } from "../lod/lod-helper";
import { BIMMesh, CurrentLod, MaterialDefinition } from "./model-types";
import { MaterialManager } from "./material-manager";

export class LODManager {
  private _materials: MaterialManager;
  // TODO: Deduplicate with other white values
  private readonly white = 0xffffffff;
  private readonly _baseTransparency = new WeakMap<LODMesh, boolean>();
  private readonly _opacityBindings = new WeakMap<LODMesh, () => void>();

  constructor(materials: MaterialManager) {
    this._materials = materials;
  }

  createMesh(geometry: THREE.BufferGeometry, request: any) {
    const material = this._materials.createTileMaterial(request);
    if (!("isLodMaterial" in material && material.isLodMaterial)) {
      throw new Error("Fragments: material is not an instance of LodMaterial.");
    }

    const { positions } = request;
    if (!positions) {
      throw new Error(
        "Fragments: no positions provided to create the LOD mesh.",
      );
    }

    const lodGeometry = new LODGeometry();
    const deleteEvent = this.deleteAttributeEvent(geometry);
    LodHelper.setLodBuffer(lodGeometry, positions, deleteEvent);
    const mesh = new LODMesh(lodGeometry, [material]);
    this._baseTransparency.set(mesh, material.transparent);
    return mesh;
  }

  updateVisibility(mesh: LODMesh, status: any) {
    const { geometry } = mesh;
    const { visibilityData, highlightData } = status;
    LodHelper.setLodVisibility(geometry, visibilityData);
    if (highlightData) {
      LodHelper.setLodHighlight(geometry, highlightData);
    }
    if (visibilityData || highlightData) {
      geometry.addGroup(0, Infinity, 0);
    }
  }

  applyHighlight(mesh: LODMesh, request: any) {
    this._opacityBindings.get(mesh)?.();
    const {
      tileData: { highlightIds, highlightData },
      modelId,
      material: index,
    } = request;
    if (!highlightData || !highlightIds) return;

    const material = mesh.material[0];
    const definitions: (MaterialDefinition | undefined)[] = [];
    const colors: (THREE.Color | undefined)[] = [];
    const opacities: (number | undefined)[] = [];
    const groupIds = new Set<number>();
    const baseOpacity = material.lodOpacity;
    const itemFilter = mesh.geometry.getItemFilter();
    let baseVisible = false;
    for (const value of itemFilter.array) {
      if (value === 1) {
        baseVisible = true;
        break;
      }
    }
    for (let i = 0; i < highlightIds.length; ++i) {
      const definition = this._materials.getHighlightProps(
        highlightIds[i],
        index,
        modelId,
      );
      definitions.push(definition);
      colors.push(
        definition?.color ? new THREE.Color(definition.color) : undefined,
      );
      opacities.push(definition?.opacity);
      if (definition?.opacityGroup !== undefined)
        groupIds.add(definition.opacityGroup);
    }
    LodHelper.setLodHighlightAppearance(
      mesh.geometry,
      highlightData,
      colors,
      opacities,
    );

    const apply = () => {
      const attribute = mesh.geometry.getAttribute(
        "itemHighlightOpacity",
      ) as THREE.InstancedBufferAttribute;
      if (!attribute) return;
      let translucent =
        baseVisible &&
        baseOpacity > 0 &&
        (this._baseTransparency.get(mesh) ?? baseOpacity < 1);
      let visible = baseVisible && baseOpacity > 0;
      for (let i = 0; i < definitions.length; ++i) {
        const definition = definitions[i];
        if (!definition) continue;
        const effective =
          definition.opacityGroup === undefined
            ? definition
            : this._materials.resolveOpacity(modelId, definition);
        const first = Math.floor(highlightData.position[i] / 2);
        const end = Math.min(
          first + highlightData.size[i] / 2,
          attribute.count,
        );
        (attribute.array as Float32Array).fill(effective.opacity, first, end);
        visible ||= effective.opacity > 0;
        translucent ||=
          effective.opacity > 0 &&
          (effective.opacity < 1 || effective.transparent === true);
      }
      attribute.needsUpdate = true;
      if (material.transparent !== translucent) {
        material.transparent = translucent;
        material.needsUpdate = true;
      }
      material.visible = visible;
    };
    const unbind = [...groupIds].map((id) =>
      this._materials.bindOpacityGroup(modelId, id, apply),
    );
    const cleanup = () => {
      for (const remove of unbind) remove();
      mesh.geometry.removeEventListener("dispose", cleanup);
      this._opacityBindings.delete(mesh);
    };
    mesh.geometry.addEventListener("dispose", cleanup);
    this._opacityBindings.set(mesh, cleanup);
    apply();
  }

  processMesh(mesh: BIMMesh, request: any) {
    const { geometry } = mesh;
    const {
      tileData: { visibilityData },
      currentLod,
    } = request;
    if (currentLod === CurrentLod.WIRES && mesh instanceof LODMesh) {
      this.updateVisibility(mesh, request.tileData);
      if (!request.tileData.highlightData) {
        this._opacityBindings.get(mesh)?.();
        mesh.material[0].visible = mesh.material[0].lodOpacity > 0;
        const transparent =
          this._baseTransparency.get(mesh) ?? mesh.material[0].lodOpacity < 1;
        if (mesh.material[0].transparent !== transparent) {
          mesh.material[0].transparent = transparent;
          mesh.material[0].needsUpdate = true;
        }
      }
    } else if (visibilityData && visibilityData.position.length > 0) {
      for (let i = 0; i < visibilityData.position.length; ++i) {
        const isWhite = visibilityData.size[i] === this.white;
        const position = visibilityData.position[i];
        const value = isWhite ? Infinity : visibilityData.size[i];
        geometry.addGroup(position, value, 0);
      }
    }
  }

  private deleteAttributeEvent(_geometry: THREE.BufferGeometry) {
    function callback(this: any) {
      delete this.array;
    }
    return callback;
  }
}
