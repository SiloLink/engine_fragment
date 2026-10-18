import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Pako from "pako";
import { VirtualFragmentsModel } from "../virtual-fragments-model";
import { VirtualTilesController } from "./virtual-tiles-controller";
import { CameraUtils } from "../../utils/geometry/camera-utils";

// Resident accounting is diagnostic; inactive cache quotas are per model.
// Disposal must remove only this model's bytes when a worker owns more than
// one model, and repeated disposal must not subtract them a second time.

const FRAG = fileURLToPath(
  new URL(
    "../../../../../../../resources/frags/small_test.frag",
    import.meta.url,
  ),
);

const consumed = () =>
  (VirtualTilesController as any)._graphicMemoryConsumed as number;

const loadRealized = async () => {
  const connection: any = { fetch: async () => {}, fetchMeshCompute: () => {} };
  const inflated = Pako.inflate(readFileSync(FRAG));
  const data = inflated.buffer.slice(
    inflated.byteOffset,
    inflated.byteOffset + inflated.byteLength,
  );
  const model = new VirtualFragmentsModel("m", data, connection, {
    multithreading: { meshConnectionThreshold: 0, meshConnectionRate: 0 },
  });
  await model.setupData();
  model.refreshView({
    cameraFrustum: CameraUtils.containing(model.getFullBBox()),
    cameraPosition: new THREE.Vector3(0, 1, 10),
    fov: 60,
    orthogonalDimension: 0.01,
    viewSize: 10000,
    graphicQuality: 0.5,
    clippingPlanes: [],
    modelPlacement: new THREE.Matrix4(),
    meshThreshold: Number.MAX_SAFE_INTEGER,
  });
  for (let i = 0; i < 500; i++) model.update(performance.now());
  return model;
};

// Each case loads and settles a real model; under a parallel suite on a busy
// machine the 5 s default is too tight and the timeout says nothing about
// the counter.
describe(
  "VirtualTilesController resident tile accounting",
  { timeout: 30000 },
  () => {
    test("disposing a model removes its realized tile memory from the diagnostic counter", async () => {
      const start = consumed();
      const model = await loadRealized();
      const loaded = consumed();
      expect(loaded).toBeGreaterThan(start);

      model.dispose();
      expect(consumed()).toBe(start);

      // Disposing twice must not subtract it again.
      model.dispose();
      expect(consumed()).toBe(start);
    });

    test("load, dispose, reload does not drift the counter", async () => {
      const start = consumed();
      for (let i = 0; i < 3; i++) {
        const model = await loadRealized();
        model.dispose();
      }
      expect(consumed()).toBe(start);
    });
  },
);
