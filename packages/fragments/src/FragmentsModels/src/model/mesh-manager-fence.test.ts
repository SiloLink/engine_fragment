import { describe, expect, test } from "vitest";
import { MeshManager } from "./mesh-manager";
import { FragmentsModel } from "./fragments-model";
import { TileRequestClass } from "./model-types";

function model(modelId: string) {
  return { modelId, _finishProcessing() {} } as FragmentsModel;
}

describe("update fences when models are removed", () => {
  test("an empty manager does not await a FINISH for previous requests", async () => {
    const meshes = new MeshManager(() => {});
    const old = model("old");
    meshes.list.set(old.modelId, old);
    meshes.beginViewUpdate(old);
    meshes.list.delete(old.modelId);
    await meshes.forceUpdateFinish();
  });

  test.each(["delete", "clear"] as const)(
    "%s rejects every in-flight view fence when its model is removed",
    async (operation) => {
      const meshes = new MeshManager(() => {});
      const a = model("a");
      meshes.list.set(a.modelId, a);
      meshes.beginViewUpdate(a);
      const first = expect(meshes.forceUpdateFinish()).rejects.toMatchObject({
        reason: "model-removed",
      });
      meshes.beginViewUpdate(a);
      const second = expect(meshes.forceUpdateFinish()).rejects.toMatchObject({
        reason: "model-removed",
      });
      if (operation === "delete") meshes.list.delete("a");
      else meshes.list.clear();
      await Promise.all([first, second]);
      await meshes.forceUpdateFinish();
    },
  );

  test("removing an idle model still waits for the remaining model's FINISH", async () => {
    const meshes = new MeshManager(() => {});
    meshes.list.set("a", model("a"));
    const b = model("b");
    meshes.list.set("b", b);
    const renderRevision = meshes.beginViewUpdate(b);
    let finished = false;
    const pending = meshes.forceUpdateFinish().then(() => {
      finished = true;
    });
    meshes.list.delete("a");
    await Promise.resolve();
    expect(finished).toBe(false);
    meshes.requests.add([
      {
        modelId: "b",
        tileRequestClass: TileRequestClass.FINISH,
        renderRevision,
      },
    ]);
    await pending;
    expect(finished).toBe(true);
  });

  test("a model loaded after an empty scene still requires its own FINISH", async () => {
    const meshes = new MeshManager(() => {});
    await meshes.forceUpdateFinish();
    const current = model("new");
    meshes.list.set("new", current);
    const renderRevision = meshes.beginViewUpdate(current);
    let finished = false;
    const pending = meshes.forceUpdateFinish().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    meshes.requests.add([
      {
        modelId: "new",
        tileRequestClass: TileRequestClass.FINISH,
        renderRevision,
      },
    ]);
    await pending;
    expect(finished).toBe(true);
  });
});
