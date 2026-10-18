import { describe, expect, it, vi } from "vitest";
import { TileRequestClass } from "./model-types";
import { RequestsManager } from "./requests-manager";

function tileRequest(
  tileRequestClass: TileRequestClass,
  tileId: number,
  tileData?: string,
  modelId = "model",
) {
  return { tileRequestClass, modelId, tileId, tileData };
}

const create = (tileId: number, tileData: string, modelId?: string) =>
  tileRequest(TileRequestClass.CREATE, tileId, tileData, modelId);
const update = (tileId: number, tileData: string, modelId?: string) =>
  tileRequest(TileRequestClass.UPDATE, tileId, tileData, modelId);
const remove = (tileId: number, modelId?: string) =>
  tileRequest(TileRequestClass.DELETE, tileId, undefined, modelId);

function queue(...requests: any[]) {
  const manager = new RequestsManager();
  manager.add(requests);
  return manager;
}

describe("queued tile requests", () => {
  it("applies an UPDATE to the CREATE that follows a queued DELETE", () => {
    const manager = queue(remove(1), create(1, "old"));

    manager.add([update(1, "new")]);

    expect(manager.list).toEqual([remove(1), create(1, "new")]);
  });

  it("drops an UPDATE for a tile whose latest queued change is a DELETE", () => {
    const deleted = queue(remove(1));
    const updatedThenDeleted = queue(update(1, "older"), remove(1));

    deleted.add([update(1, "new")]);
    updatedThenDeleted.add([update(1, "new")]);

    expect(deleted.list).toEqual([remove(1)]);
    expect(updatedThenDeleted.list).toEqual([update(1, "older"), remove(1)]);
  });

  it("merges consecutive state into a queued CREATE or UPDATE", () => {
    const created = queue(create(1, "old"));
    const updated = queue(update(1, "old"));

    created.add([update(1, "new")]);
    updated.add([update(1, "new")]);

    expect(created.list).toEqual([create(1, "new")]);
    expect(updated.list).toEqual([update(1, "new")]);
  });

  it.each([TileRequestClass.CREATE, TileRequestClass.UPDATE])(
    "retains the latest index order for each chunk when coalescing into %s",
    (kind) => {
      const first = {
        ...tileRequest(kind, 1, "initial"),
        indexUpdates: [{ start: 0, indices: new Uint16Array([0, 2, 1]) }],
      };
      const manager = queue(first);
      const replacement = { start: 0, indices: new Uint16Array([2, 1, 0]) };
      const adjacent = { start: 3, indices: new Uint16Array([4, 3, 5]) };
      manager.add([
        { ...update(1, "changed"), indexUpdates: [replacement, adjacent] },
        update(1, "visibility-only"),
      ]);

      expect(manager.list).toHaveLength(1);
      expect(manager.list[0]).toMatchObject({
        tileData: "visibility-only",
        indexUpdates: [replacement, adjacent],
      });
    },
  );

  it("keeps UPDATEs of different models with the same tile id apart", () => {
    const manager = queue(remove(1, "a"), create(1, "a-old", "a"));

    manager.add([update(1, "b-new", "b")]);
    manager.add([update(1, "a-new", "a")]);

    expect(manager.list).toEqual([
      remove(1, "a"),
      create(1, "a-new", "a"),
      update(1, "b-new", "b"),
    ]);
  });
});

describe("queued completion boundaries", () => {
  const finish = (modelId = "model") => ({
    tileRequestClass: TileRequestClass.FINISH as const,
    modelId,
    renderRevision: 1,
  });

  it.each([create, update, remove])(
    "does not coalesce a later change across its model's FINISH",
    (later) => {
      const first = create(1, "first");
      const completion = finish();
      const next = later === remove ? remove(1) : later(1, "later");
      const manager = queue(first, completion, next);
      expect(manager.list).toEqual([first, completion, next]);
      expect(first.tileData).toBe("first");
    },
  );

  it("can coalesce across another model's completion", () => {
    const manager = queue(
      create(1, "first"),
      finish("other"),
      update(1, "last"),
    );
    expect(manager.list).toEqual([create(1, "last"), finish("other")]);
  });

  it("notifies once after the whole batch has been enqueued", () => {
    const manager = new RequestsManager();
    const batches: any[][] = [];
    manager.onPending = () => batches.push([...manager.list]);
    const batch = [create(1, "first"), finish(), create(2, "last")];
    manager.add(batch as any);
    expect(batches).toEqual([batch]);
  });

  it("drops late batches after disposal", () => {
    const manager = queue(create(1, "first"));
    const pending = vi.fn();
    manager.onPending = pending;
    manager.dispose();
    manager.add([finish()]);
    expect(manager.list).toEqual([]);
    expect(pending).not.toHaveBeenCalled();
  });
});
