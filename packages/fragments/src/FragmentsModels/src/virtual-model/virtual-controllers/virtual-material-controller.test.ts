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

  it("reuses semantically identical preserved highlights", () => {
    const onTransfer = vi.fn();
    const controller = new VirtualMaterialController("model", onTransfer);
    const opacityOverride = {
      preserveOriginalMaterial: true,
      _explicitProps: ["opacity", "transparent"],
    } satisfies Partial<MaterialDefinition>;

    const [first, duplicate] = controller.transfer([
      material(0.08, opacityOverride),
      material(0.08, {
        ...opacityOverride,
        _explicitProps: ["transparent", "opacity"],
      }),
    ]);
    const [reused] = controller.transfer([material(0.08, opacityOverride)]);

    expect(duplicate).toBe(first);
    expect(reused).toBe(first);
    expect(onTransfer.mock.calls[0]?.[0].materialDefinitions).toHaveLength(1);
    expect(onTransfer.mock.calls[1]?.[0].materialDefinitions).toHaveLength(0);
  });

  it("keeps preserved highlights separate when their effective overrides differ", () => {
    const controller = new VirtualMaterialController("model", vi.fn());
    const [opacityOnly, opacityAndTransparency, differentOpacity, regular] =
      controller.transfer([
        material(0.08, {
          preserveOriginalMaterial: true,
          _explicitProps: ["opacity"],
        }),
        material(0.08, {
          preserveOriginalMaterial: true,
          _explicitProps: ["opacity", "transparent"],
        }),
        material(0.2, {
          preserveOriginalMaterial: true,
          _explicitProps: ["opacity", "transparent"],
        }),
        material(0.08),
      ]);

    expect(
      new Set([opacityOnly, opacityAndTransparency, differentOpacity, regular]),
    ).toHaveLength(4);
  });

  it("compares explicitly overridden colors by value", () => {
    const controller = new VirtualMaterialController("model", vi.fn());
    const [first, duplicate, different] = controller.transfer([
      material(1, {
        color: new Color(0.1, 0.2, 0.3),
        preserveOriginalMaterial: true,
        _explicitProps: ["color"],
      }),
      material(1, {
        color: new Color(0.1, 0.2, 0.3),
        preserveOriginalMaterial: true,
        _explicitProps: ["color"],
      }),
      material(1, {
        color: new Color(0.3, 0.2, 0.1),
        preserveOriginalMaterial: true,
        _explicitProps: ["color"],
      }),
    ]);

    expect(duplicate).toBe(first);
    expect(different).not.toBe(first);
  });
});
