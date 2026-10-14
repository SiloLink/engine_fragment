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
      if (property === "opacityScale") continue;
      if ((definition as any)[property] !== undefined) {
        (combined as any)[property] = (definition as any)[property];
      }
    }
    // A relative opacity scales whatever opacity this original material has.
    const scale = definition.opacityScale;
    if (scale !== undefined) {
      combined.opacity = (original.opacity ?? 1) * scale;
      combined.transparent = original.transparent || combined.opacity < 1;
    }
    return combined;
  }

  static isSame(a: MaterialDefinition, b: MaterialDefinition) {
    return this.getKey(a) === this.getKey(b);
  }

  /** Returns a stable key including rendering and inheritance semantics. */
  static getKey(material: MaterialDefinition) {
    const { color, _explicitProps, ...properties } = material;
    // Missing properties on preserved highlights inherit from the base material.
    // They must stay distinct from explicitly supplied default values.
    if (!material.preserveOriginalMaterial) {
      properties.opacity ??= 1;
      properties.renderedFaces ??= RenderedFaces.ONE;
    }
    return JSON.stringify([
      color && [color.r, color.g, color.b, color.isColor === true],
      [...new Set(_explicitProps ?? [])].sort(),
      Object.entries(properties)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ]);
  }
}
