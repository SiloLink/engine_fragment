import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Pako from "pako";
import * as THREE from "three";
import { VirtualFragmentsModel } from "../virtual-fragments-model";
import { MaterialManager } from "../../model/material-manager";
import { RequestsManager } from "../../model/requests-manager";
import { MaterialDefinition } from "../../model/model-types";
import { MaterialUtils } from "../../utils/geometry/material-utils";

const FRAG = fileURLToPath(
  new URL(
    "../../../../../../../resources/frags/small_test.frag",
    import.meta.url,
  ),
);

// A worker-side model wired to a real main-thread MaterialManager, as in
// highlight-ids.test.ts, so both ends see the same highlight definitions.
const load = async () => {
  const mainMaterials = new MaterialManager();
  const requests = new RequestsManager();
  const meshes: any = { materials: mainMaterials };
  const connection: any = {
    fetch: async (request: any) => requests.handleRequest(meshes, request),
    fetchMeshCompute: () => {},
  };
  const inflated = Pako.inflate(readFileSync(FRAG));
  const data = inflated.buffer.slice(
    inflated.byteOffset,
    inflated.byteOffset + inflated.byteLength,
  );
  const model = new VirtualFragmentsModel("m", data, connection, {
    multithreading: { meshConnectionThreshold: 0, meshConnectionRate: 0 },
  });
  await model.setupData();
  const workerList = (model.materials as any)._list as MaterialDefinition[];
  return { mainMaterials, model, workerList };
};

const material = (opacity: number): MaterialDefinition => ({
  color: new THREE.Color(0xffffff),
  renderedFaces: 0 as any,
  opacity,
  transparent: opacity < 1,
});

const relative = (scale: number): MaterialDefinition =>
  ({
    opacityScale: scale,
    preserveOriginalMaterial: true,
    _explicitProps: ["opacityScale", "opacity", "transparent"],
  }) as MaterialDefinition;

describe("relative opacity", () => {
  test("scales each original material's opacity and shows it as it is at 1", () => {
    const frame = material(1);
    const glass = material(0.2);

    const fadedFrame = MaterialUtils.mergeHighlight(frame, relative(0.5));
    const fadedGlass = MaterialUtils.mergeHighlight(glass, relative(0.5));
    expect([fadedFrame.opacity, fadedFrame.transparent]).toEqual([0.5, true]);
    expect([fadedGlass.opacity, fadedGlass.transparent]).toEqual([0.1, true]);
    expect(fadedGlass).not.toHaveProperty("opacityScale");

    const fullFrame = MaterialUtils.mergeHighlight(frame, relative(1));
    const fullGlass = MaterialUtils.mergeHighlight(glass, relative(1));
    expect([fullFrame.opacity, fullFrame.transparent]).toEqual([1, false]);
    expect([fullGlass.opacity, fullGlass.transparent]).toEqual([0.2, true]);
  });

  test("the latest opacity of either kind wins and color highlights stay", async () => {
    const { model } = await load();
    const red = { r: 1, g: 0, b: 0 } as any;
    model.setColor(undefined as any, red);
    model.setOpacity(undefined as any, 0.3);
    model.setOpacity(undefined as any, 0.5, true);
    const [localId] = model.getHighlightItemIds();
    let [definition] = model.getHighlight([localId]);
    expect(definition.opacityScale).toBe(0.5);
    expect(definition.opacity).toBeUndefined();
    expect(definition.color).toBeDefined();
    // A repeated fade replaces the scale instead of compounding it.
    model.setOpacity(undefined as any, 0.5, true);
    [definition] = model.getHighlight([localId]);
    expect(definition.opacityScale).toBe(0.5);

    model.setOpacity(undefined as any, 0.3);
    [definition] = model.getHighlight([localId]);
    expect(definition.opacity).toBe(0.3);
    expect(definition.opacityScale).toBeUndefined();

    model.setOpacity(undefined as any, 0.5, true);
    model.resetOpacity(undefined as any);
    [definition] = model.getHighlight([localId]);
    expect(definition.opacityScale).toBeUndefined();
    expect(definition.opacity).toBeUndefined();
    expect(definition.color).toBeDefined();
  });

  test("the main thread and the tile split resolve the scaled opacity", async () => {
    const { mainMaterials, model, workerList } = await load();
    const base = workerList.length;
    model.setOpacity(undefined as any, 0.5, true);
    const highlightId = base;
    const original = workerList[0];

    // The props LOD lines take their highlight opacity from.
    const props = mainMaterials.getHighlightProps(highlightId, 0, "m")!;
    expect(props.opacity).toBeCloseTo((original.opacity ?? 1) * 0.5);
    expect(model.materials.isOpaque(0, highlightId)).toBe(false);

    // At full scale the original material is drawn as it is.
    model.setOpacity(undefined as any, 1, true);
    const fullId = workerList.length - 1;
    expect(model.materials.isOpaque(0, fullId)).toBe(
      model.materials.isOpaque(0),
    );
  });
});
