import * as THREE from "three";
import { RenderedFaces } from "../../../../Schema";
import { MaterialDefinition } from "../../model/model-types";

export class MaterialUtils {
  static mergeHighlight(
    original: MaterialDefinition,
    highlight?: MaterialDefinition,
  ) {
    const combined: MaterialDefinition = { ...original };
    if (!highlight) return combined;

    const { preserveOriginalMaterial, _explicitProps, ...definition } =
      highlight;
    if (!preserveOriginalMaterial) {
      Object.assign(combined, definition);
      return combined;
    }

    for (const property of _explicitProps ?? []) {
      if ((definition as any)[property] !== undefined) {
        (combined as any)[property] = (definition as any)[property];
      }
    }
    return combined;
  }

  static isSame(a: MaterialDefinition, b: MaterialDefinition) {
    const isSameColor = this.checkSameColor(a.color, b.color);
    const isSameOpacity = this.checkSame(a.opacity, b.opacity, 1.0);
    const facesA = a.renderedFaces;
    const facesB = b.renderedFaces;
    const isSameFaces = this.checkSame(facesA, facesB, RenderedFaces.ONE);
    return isSameColor && isSameOpacity && isSameFaces;
  }

  static isSamePreservedHighlight(
    a: MaterialDefinition,
    b: MaterialDefinition,
  ) {
    if (!a.preserveOriginalMaterial || !b.preserveOriginalMaterial) {
      return false;
    }

    const propertiesA = [...new Set(a._explicitProps ?? [])].sort();
    const propertiesB = [...new Set(b._explicitProps ?? [])].sort();
    if (propertiesA.length !== propertiesB.length) return false;

    for (let index = 0; index < propertiesA.length; index++) {
      const property = propertiesA[index];
      if (property !== propertiesB[index]) return false;

      const valueA = (a as any)[property];
      const valueB = (b as any)[property];
      const isSame =
        property === "color"
          ? this.checkSameColor(valueA, valueB)
          : valueA === valueB;
      if (!isSame) return false;
    }

    return true;
  }

  private static checkSame(a: any, b: any, fallback: any): boolean {
    if (a === b) {
      return true;
    }

    if (a === fallback && b === undefined) {
      return true;
    }

    if (a === undefined && b === fallback) {
      return true;
    }

    return false;
  }

  private static checkSameColor(a: THREE.Color, b: THREE.Color) {
    if (a === b) {
      return true;
    }

    if (a === undefined || b === undefined) {
      return false;
    }

    const { r: ar, g: ag, b: ab } = a;
    const { r: br, g: bg, b: bb } = b;

    if (ar === br && ag === bg && ab === bb) {
      return true;
    }

    return false;
  }
}
