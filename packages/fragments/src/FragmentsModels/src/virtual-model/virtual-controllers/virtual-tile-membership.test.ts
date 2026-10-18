import { describe, expect, it } from "vitest";
import { VirtualTilesController } from "./virtual-tiles-controller";
import type { TileData } from "../virtual-meshes";
import { MultiBufferData } from "../../utils";

describe("tile membership from applied draw ranges", () => {
  function fixture(indexed = true) {
    const controller = Object.create(VirtualTilesController.prototype);
    const itemIds = [0, 0x12345678, 0xffffffff, 0x12345678, 256];
    controller.itemId = (sample: number) => itemIds[sample];
    // Sample 1 spans two chunks; sample 3 shares its item; sample 4 is empty.
    const tile = {
      sampleSpans: new Map([
        [0, { start: 0, count: 1 }],
        [1, { start: 1, count: 2 }],
        [2, { start: 3, count: 1 }],
        [3, { start: 4, count: 1 }],
        [4, { start: 5, count: 1 }],
      ]),
      indexCount: indexed ? 30 : 0,
      positionCount: 90,
    } as TileData;
    const locations = [0, 6, 12, 18, 24, 30];
    const visible = new MultiBufferData(6, false);
    const highlighted = new MultiBufferData(6, false);
    const read = () =>
      Array.from(
        controller.getVisibleItemIds(tile, locations, [
          MultiBufferData.get(visible, locations, Boolean),
          MultiBufferData.get(highlighted, locations, Boolean),
        ]),
      );
    return { visible, highlighted, read };
  }

  it.each([true, false])(
    "unions active normal and highlight ranges (indexed=%s)",
    (indexed) => {
      const f = fixture(indexed);
      expect(f.read()).toEqual([]);
      f.visible.update(0, true);
      f.highlighted.update(1, true);
      f.highlighted.update(2, true);
      f.visible.update(3, true);
      f.highlighted.update(4, true);
      f.visible.update(5, true);
      expect(f.read()).toEqual([0, 0x12345678, 0xffffffff]);
      f.highlighted.update(1, false);
      f.highlighted.update(2, false);
      expect(f.read()).toEqual([0, 0xffffffff, 0x12345678]);
      f.highlighted.update(4, false);
      expect(f.read()).toEqual([0, 0xffffffff]);
    },
  );

  it("handles a range extending through the last real sample", () => {
    const f = fixture();
    for (let slot = 3; slot < 6; slot++) f.visible.update(slot, true);
    expect(f.read()).toEqual([0xffffffff, 0x12345678]);
  });
});
