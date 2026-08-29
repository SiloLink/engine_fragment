import { describe, expect, it, vi } from "vitest";
import { Color } from "three";
import { MaterialDefinition } from "../../model/model-types";
import { VirtualMaterialController } from "./virtual-material-controller";

function material(
  opacity: number,
  overrides: Partial<MaterialDefinition> = {},
): MaterialDefinition {
  return {
    color: new Color(1, 1, 1),
    renderedFaces: 0 as MaterialDefinition["renderedFaces"],
    opacity,
    transparent: opacity < 1,
    ...overrides,
  };
}

describe("virtual material opacity contract", () => {
  it("resolves effective opacity with the same explicit highlight semantics as rendering", () => {
    const controller = new VirtualMaterialController("model", vi.fn());
    const [
      opaque,
      translucent,
      translucentOverride,
      opaqueOverride,
      colorOnly,
    ] = controller.transfer([
      material(1),
      material(0.4),
      material(0.25, {
        preserveOriginalMaterial: true,
        _explicitProps: ["opacity", "transparent"],
      }),
      material(1, {
        preserveOriginalMaterial: true,
        _explicitProps: ["opacity", "transparent"],
      }),
      material(0, {
        preserveOriginalMaterial: true,
        _explicitProps: ["color"],
      }),
    ]);

    expect(controller.isOpaque(opaque)).toBe(true);
    expect(controller.isOpaque(translucent)).toBe(false);
    expect(controller.isOpaque(opaque, translucentOverride)).toBe(false);
    expect(controller.isOpaque(translucent, opaqueOverride)).toBe(true);
    expect(controller.isOpaque(opaque, colorOnly)).toBe(true);
  });
});
