import { describe, expect, it, vi } from "vitest";
import { MeshManager } from "./mesh-manager";
import { FragmentsModel } from "./fragments-model";
import { TileRequestClass } from "./model-types";

function addModel(meshes: MeshManager, modelId: string) {
  const model = {
    modelId,
    _finishProcessing: vi.fn(),
    _failProcessing: vi.fn(),
  } as unknown as FragmentsModel;
  meshes.list.set(modelId, model);
  return model;
}

function finish(meshes: MeshManager, modelId: string, renderRevision: number) {
  meshes.requests.add([
    { tileRequestClass: TileRequestClass.FINISH, modelId, renderRevision },
  ]);
}

describe("model view completion", () => {
  it("preserves model and revision identity independently of the failure message", async () => {
    const meshes = new MeshManager(() => {});
    const model = addModel(meshes, "model: a: b");
    const revision = meshes.beginViewUpdate(model);
    const cause = new Error("arbitrary diagnostic wording");
    const failed = expect(meshes.forceUpdateFinish()).rejects.toMatchObject({
      reason: "view-failed",
      modelId: model.modelId,
      renderRevision: revision,
      cause,
    });
    meshes.failViewUpdate(model, revision, cause);
    await failed;
  });

  it("reports a failed latest view to its model, but not a stale one", () => {
    const meshes = new MeshManager(() => {});
    const model = addModel(meshes, "failing");
    const stale = meshes.beginViewUpdate(model);
    const latest = meshes.beginViewUpdate(model);

    meshes.failViewUpdate(model, stale, new Error("stale"));
    expect(model._failProcessing).not.toHaveBeenCalled();

    meshes.requests.add([
      {
        tileRequestClass: TileRequestClass.FINISH,
        modelId: model.modelId,
        renderRevision: latest,
        error: "sample failed",
      } as any,
    ]);
    expect(model._failProcessing).toHaveBeenCalledOnce();
    expect(model._failProcessing).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "view-failed",
        modelId: model.modelId,
        renderRevision: latest,
      }),
    );
    expect(model._finishProcessing).not.toHaveBeenCalled();
  });

  it("carries model identity when a pending view is removed", async () => {
    const meshes = new MeshManager(() => {});
    const model = addModel(meshes, "removed");
    const revision = meshes.beginViewUpdate(model);
    const failed = expect(meshes.forceUpdateFinish()).rejects.toMatchObject({
      reason: "model-removed",
      modelId: "removed",
      renderRevision: revision,
    });
    meshes.list.delete(model.modelId);
    await failed;
  });
  it("waits for every model even when a later view completes first", async () => {
    const meshes = new MeshManager(() => {});
    const slow = addModel(meshes, "slow");
    const fast = addModel(meshes, "fast");
    const slowRevision = meshes.beginViewUpdate(slow);
    const fastRevision = meshes.beginViewUpdate(fast);
    const resolved = vi.fn();
    const wait = meshes.forceUpdateFinish().then(resolved);
    finish(meshes, "fast", fastRevision);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(slow._finishProcessing).not.toHaveBeenCalled();
    finish(meshes, "slow", slowRevision);
    await wait;
    expect(resolved).toHaveBeenCalledOnce();
  });

  it("does not mark a newer model view complete for an older FINISH", async () => {
    const meshes = new MeshManager(() => {});
    const model = addModel(meshes, "model");
    const first = meshes.beginViewUpdate(model);
    const second = meshes.beginViewUpdate(model);
    const resolved = vi.fn();
    const wait = meshes.forceUpdateFinish().then(resolved);
    finish(meshes, "model", first);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(model._finishProcessing).not.toHaveBeenCalled();
    finish(meshes, "model", second);
    await wait;
    expect(model._finishProcessing).toHaveBeenCalledOnce();
  });

  it("captures the requested revisions rather than waiting for future work", async () => {
    const meshes = new MeshManager(() => {});
    const model = addModel(meshes, "model");
    const first = meshes.beginViewUpdate(model);
    const wait = meshes.forceUpdateFinish();
    const second = meshes.beginViewUpdate(model);
    finish(meshes, "model", first);
    await wait;
    expect(model._finishProcessing).not.toHaveBeenCalled();
    finish(meshes, "model", second);
  });

  it("rejects an outstanding wait on disposal and ignores FINISH from the old instance", async () => {
    const meshes = new MeshManager(() => {});
    const oldModel = addModel(meshes, "model");
    const oldRevision = meshes.beginViewUpdate(oldModel);
    const cancelled = expect(meshes.forceUpdateFinish()).rejects.toThrow(
      /removed|replaced/,
    );
    meshes.list.delete("model");
    await cancelled;
    const replacement = addModel(meshes, "model");
    const revision = meshes.beginViewUpdate(replacement);
    const resolved = vi.fn();
    const wait = meshes.forceUpdateFinish().then(resolved);
    finish(meshes, "model", oldRevision);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(replacement._finishProcessing).not.toHaveBeenCalled();
    finish(meshes, "model", revision);
    await wait;
  });

  it("rejects an outstanding wait when its model is replaced without a delete", async () => {
    const meshes = new MeshManager(() => {});
    const oldModel = addModel(meshes, "model");
    meshes.beginViewUpdate(oldModel);
    const cancelled = expect(meshes.forceUpdateFinish()).rejects.toThrow(
      /removed|replaced/,
    );
    addModel(meshes, "model");
    await cancelled;
  });

  it("rejects pending fences if dispatch of their requested view fails", async () => {
    const meshes = new MeshManager(() => {});
    const model = addModel(meshes, "model");
    const revision = meshes.beginViewUpdate(model);
    const failed = expect(meshes.forceUpdateFinish()).rejects.toThrow(
      "worker unavailable",
    );
    meshes.failViewUpdate(model, revision, new Error("worker unavailable"));
    await failed;
    const next = meshes.beginViewUpdate(model);
    const recovered = meshes.forceUpdateFinish();
    finish(meshes, "model", next);
    await recovered;
  });

  it("resolves with no requested views, or views already applied", async () => {
    const meshes = new MeshManager(() => {});
    const model = addModel(meshes, "model");
    await meshes.forceUpdateFinish();
    const revision = meshes.beginViewUpdate(model);
    finish(meshes, "model", revision);
    await meshes.forceUpdateFinish();
  });
});
