import * as THREE from "three";
import { LineMaterialParameters } from "three/examples/jsm/lines/LineMaterial.js";
import {
  ObjectClass,
  MaterialDefinition,
  CurrentLod,
  BIMMesh,
  BIMMaterial,
  MaterialData,
} from "./model-types";
import { CRC } from "../utils";
import { LodMaterial } from "../lod";
import { DataMap } from "../../../Utils";
import type { OpacityGroupOptions } from "./opacity-group";
import { MaterialUtils } from "../utils/geometry/material-utils";

type LiveOpacityState = {
  opacity: number;
  relative: boolean;
  bindings: Set<() => void>;
};

export class MaterialManager {
  readonly list = new DataMap<number, BIMMaterial>();

  private readonly _modelMaterialMapping = new Map<string, Set<number>>();
  private readonly _definitions = new Map<string, MaterialDefinition[]>();
  private readonly _idGenerator = new CRC();
  private readonly white = 0xffffffff;
  private _nextTileMaterialId = 0;
  private readonly _tileMaterialIds = new WeakMap<THREE.Material, number>();
  private readonly _opacityGroups = new Map<
    string,
    Map<number, LiveOpacityState>
  >();

  createOpacityGroup(
    modelId: string,
    id: number,
    options: OpacityGroupOptions,
  ) {
    let groups = this._opacityGroups.get(modelId);
    if (!groups) this._opacityGroups.set(modelId, (groups = new Map()));
    groups.set(id, {
      opacity: options.opacity,
      relative: options.relative ?? false,
      bindings: new Set(),
    });
  }

  setOpacityGroupValue(modelId: string, id: number, opacity: number) {
    const group = this._opacityGroups.get(modelId)?.get(id);
    if (!group) throw new Error("Fragments: opacity group has been disposed.");
    group.opacity = opacity;
    for (const update of group.bindings) update();
  }

  removeOpacityGroup(modelId: string, id: number, restore = true) {
    const groups = this._opacityGroups.get(modelId);
    const group = groups?.get(id);
    groups?.delete(id);
    // Existing tiles return to their base opacity until the membership update
    // replaces their highlight groups. Newer owners use distinct materials.
    if (group && restore) for (const update of group.bindings) update();
    group?.bindings.clear();
    if (groups?.size === 0) this._opacityGroups.delete(modelId);
  }

  bindOpacityGroup(modelId: string, id: number, update: () => void) {
    const bindings = this._opacityGroups.get(modelId)?.get(id)?.bindings;
    bindings?.add(update);
    return () => {
      bindings?.delete(update);
    };
  }

  resolveOpacity(modelId: string, definition: MaterialDefinition) {
    const group =
      definition.opacityGroup === undefined
        ? undefined
        : this._opacityGroups.get(modelId)?.get(definition.opacityGroup);
    if (!group) return definition;
    const opacity = (group.relative ? definition.opacity : 1) * group.opacity;
    return {
      ...definition,
      opacity,
      transparent: (group.relative && definition.transparent) || opacity < 1,
    };
  }

  static resetColors(definitions: MaterialDefinition[]) {
    for (const definition of definitions) {
      if (!(definition && definition.color)) continue;
      const { color } = definition;
      if (color.isColor) continue;
      const { r, g, b } = color;
      // IFC colors are stored in sRBG color space
      definition.color = new THREE.Color().setRGB(
        r,
        g,
        b,
        THREE.SRGBColorSpace,
      );
    }
  }

  dispose(modelId: string) {
    this._opacityGroups.delete(modelId);
    this._definitions.delete(modelId);
    const ids = this._modelMaterialMapping.get(modelId);
    if (!ids) return;
    for (const id of ids) {
      const material = this.list.get(id);
      if (!material) continue;
      material.dispose();
      this.list.delete(id);
    }
    this._modelMaterialMapping.delete(modelId);
  }

  /**
   * Release a model's slot in the per-model definitions and mapping tables
   * without disposing the underlying THREE materials in `list`. Used by
   * `editor.save()` so a fresh model can register under the same modelId
   * while the outgoing model's tiles still render normally.
   */
  releaseModelSlot(modelId: string) {
    this._opacityGroups.delete(modelId);
    this._definitions.delete(modelId);
    this._modelMaterialMapping.delete(modelId);
  }

  get(data: MaterialDefinition, request: any) {
    const id = this.getMaterialId(data, request);
    return this.getUniqueMaterial(id, data, request);
  }

  /**
   * LOD transparency depends on every highlighted range in a tile. Allocate
   * its base material separately, while keeping it in the public registry so
   * renderer configuration and clipping updates reach it.
   */
  createTileMaterial(request: any) {
    const definition = this.getDefinitionFromRequest(request);
    this.getMaterialId(definition, request);
    this._idGenerator.compute("tile");
    this._idGenerator.compute(++this._nextTileMaterialId);
    const id = this._idGenerator.value;
    const material = this.getUniqueMaterial(id, definition, request);
    this._tileMaterialIds.set(material, id);
    return material;
  }

  private getMaterialId(data: MaterialDefinition, request: any) {
    const { modelId, objectClass, currentLod, templateId } = request;
    if (!(modelId && objectClass !== undefined && currentLod !== undefined)) {
      throw new Error(
        "Fragments: material definition information is missing to create the material.",
      );
    }
    this._idGenerator.fromMaterialData({
      modelId,
      objectClass,
      currentLod,
      templateId,
      ...data,
    });
    return this._idGenerator.value;
  }

  releaseTileMaterial(modelId: string, material: THREE.Material) {
    const id = this._tileMaterialIds.get(material);
    if (id === undefined) return false;
    this._tileMaterialIds.delete(material);
    if (this.list.get(id) === material) {
      this.list.delete(id);
      this._modelMaterialMapping.get(modelId)?.delete(id);
    }
    material.dispose();
    return true;
  }

  /**
   * Appends material definitions for a model. `firstId`, when given, is the
   * id the worker assigned to `materials[0]`; definitions at or above it are
   * ones the worker has reclaimed (see #299) and are replaced.
   */
  addDefinitions(
    modelID: string,
    materials: MaterialDefinition[],
    firstId?: number,
  ) {
    const definitions = this._definitions.get(modelID);
    if (definitions) {
      if (firstId !== undefined && firstId < definitions.length) {
        definitions.length = firstId;
      }
      definitions.push(...materials);
    } else {
      this._definitions.set(modelID, materials);
    }
  }

  createHighlights(mesh: BIMMesh, request: any) {
    const {
      tileData: { highlightData, highlightIds },
      modelId,
      material: index,
    } = request;

    const { geometry } = mesh;
    const materials = (mesh.material as THREE.Material[]).slice(0, 2);
    const localMap = new Map<number, number>();

    const materialDefinitions = this._definitions.get(modelId);
    if (!materialDefinitions) return materials;

    for (let i = 0; i < highlightData.position.length; i++) {
      const highlightIndex = highlightIds[i];
      this.processHighlight(
        localMap,
        highlightIndex,
        materialDefinitions,
        index,
        request,
        materials,
      );
      const first = highlightData.position[i];
      const value = highlightData.size[i];
      const isWhite = value === this.white;
      const size = isWhite ? Infinity : value;
      geometry.addGroup(first, size, localMap.get(highlightIds[i])!);
    }

    return materials;
  }

  getHighlightProps(
    highlightIndex: number,
    originalIndex: number,
    modelId: string,
  ) {
    const materialDefinitions = this._definitions.get(modelId);
    if (!materialDefinitions) return undefined;
    const original = materialDefinitions[originalIndex];
    const highlight = materialDefinitions[highlightIndex];
    if (!highlight || !original) return undefined;
    return MaterialUtils.mergeHighlight(original, highlight);
  }

  getFromRequest(request: any) {
    return this.get(this.getDefinitionFromRequest(request), request);
  }

  private getDefinitionFromRequest(request: any) {
    const { material: index, modelId } = request;
    const definition = this._definitions.get(modelId)?.[index];
    if (!definition) {
      throw new Error(`Fragments: Missing mesh material for index ${index}`);
    }
    return definition;
  }

  private newLODMaterial(data: MaterialData, request: any) {
    const { data: definition } = data;
    const color = new THREE.Color(definition.color);
    if (request.currentLod === CurrentLod.WIRES) {
      color.multiplyScalar(0.85);
    }

    const parameters: LineMaterialParameters = {
      color,
      ...this.getParameters(definition),
    };

    const material = new LodMaterial(parameters);
    material.userData = { customId: definition.customId };
    return material;
  }

  private getParameters(data: MaterialDefinition) {
    const { opacity, transparent } = data;
    const isTranslucent = opacity < 1;
    const parameters: THREE.MaterialParameters = {
      opacity,
      transparent: transparent || isTranslucent,
      clipIntersection: false,
    };
    return parameters;
  }

  private new(data: MaterialDefinition, request: any) {
    const { objectClass, templateId } = request;
    let material: BIMMaterial;

    if (objectClass === ObjectClass.SHELL) {
      material = new THREE.MeshLambertMaterial({
        color: data.color,
        transparent: data.opacity < 1,
        opacity: data.opacity,
        userData: { customId: data.customId, localId: data.localId },
        depthTest: data.depthTest ?? true,
        depthWrite: data.depthWrite ?? true,
        polygonOffset:
          (data.polygonOffsetFactor ?? 0) !== 0 ||
          (data.polygonOffsetUnits ?? 0) !== 0,
        polygonOffsetFactor: data.polygonOffsetFactor ?? 0,
        polygonOffsetUnits: data.polygonOffsetUnits ?? 0,
        side: data.renderedFaces === 1 ? THREE.DoubleSide : THREE.FrontSide,
      });
    } else if (objectClass === ObjectClass.LINE) {
      material = this.newLODMaterial(
        { data, instancing: templateId !== undefined },
        request,
      );
    } else {
      throw new Error("Fragments: Unsupported object class");
    }

    return material;
  }

  private addMaterialToModel(modelId: string, id: number) {
    let modelMaterials = this._modelMaterialMapping.get(modelId);
    if (!modelMaterials) {
      modelMaterials = new Set();
      this._modelMaterialMapping.set(modelId, modelMaterials);
    }
    modelMaterials.add(id);
  }

  private processHighlight(
    localMap: Map<number, number>,
    highlightIndex: any,
    materialDefinitions: MaterialDefinition[],
    index: any,
    request: any,
    materials: THREE.Material[],
  ) {
    if (!localMap.has(highlightIndex)) {
      const original = materialDefinitions[index];
      const highlight = materialDefinitions[highlightIndex];
      const combined = MaterialUtils.mergeHighlight(original, highlight);
      const material = this.get(combined, request);
      materials.push(material);
      localMap.set(highlightIndex, materials.length - 1);
    }
  }

  private getUniqueMaterial(
    id: number,
    data: MaterialDefinition,
    request: any,
  ) {
    const modelId = request.modelId;
    const material = this.list.get(id);
    if (material) return material;
    const newMaterial = this.new(this.resolveOpacity(modelId, data), request);
    if (data.opacityGroup !== undefined) {
      const apply = () => {
        const effective = this.resolveOpacity(modelId, data);
        newMaterial.opacity = effective.opacity;
        const transparent = effective.transparent || effective.opacity < 1;
        if (newMaterial.transparent !== transparent) {
          newMaterial.transparent = transparent;
          newMaterial.needsUpdate = true;
        }
        newMaterial.visible = effective.opacity > 0;
        newMaterial.depthWrite =
          effective.opacity > 0 && (data.depthWrite ?? true);
        if (newMaterial instanceof LodMaterial)
          newMaterial.lodOpacity = effective.opacity;
      };
      this.bindOpacityGroup(modelId, data.opacityGroup, apply);
      apply();
    }
    this.list.set(id, newMaterial);
    this.addMaterialToModel(modelId, id);
    return this.list.get(id)!;
  }
}
