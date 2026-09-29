import { describe, expect, it } from "vitest";
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
