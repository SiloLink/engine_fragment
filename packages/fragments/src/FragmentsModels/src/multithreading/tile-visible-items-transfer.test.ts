import { describe, expect, it } from "vitest";
import { MultithreadingHelper } from "./multithreading-helper";
import { TileRequestClass } from "../model/model-types";

describe.each([TileRequestClass.CREATE, TileRequestClass.UPDATE])(
  "tile class %s visible-item transfer",
  (tileRequestClass) => {
    it("transfers compact true IDs independently of the per-vertex picker attribute", () => {
      const visibleItemIds = new Uint32Array([0, 70000, 0xffffffff]);
      const itemIds = new Uint8Array([0, 0, 0, 1]);
      const request = {
        tileRequestClass,
        ...(tileRequestClass === TileRequestClass.CREATE ? { itemIds } : {}),
        tileData: { visibleItemIds },
      };
      const transfer = MultithreadingHelper.getRequestContent({
        list: [request],
      });
      expect(
        transfer.filter((buffer) => buffer === visibleItemIds.buffer),
      ).toHaveLength(1);
      const received = structuredClone(request, { transfer });
      expect(visibleItemIds.byteLength).toBe(0);
      expect(received.tileData.visibleItemIds).toEqual(
        new Uint32Array([0, 70000, 0xffffffff]),
      );
      if (tileRequestClass === TileRequestClass.CREATE) {
        expect(itemIds.byteLength).toBe(0);
        expect(received.itemIds).toEqual(new Uint8Array([0, 0, 0, 1]));
      }
    });

    it("transfers an empty membership for an inactive retained tile", () => {
      const request = {
        tileRequestClass,
        tileData: { visibleItemIds: new Uint32Array() },
      };
      const received = structuredClone(request, {
        transfer: MultithreadingHelper.getRequestContent({ list: [request] }),
      });
      expect(received.tileData.visibleItemIds).toEqual(new Uint32Array());
    });
  },
);
