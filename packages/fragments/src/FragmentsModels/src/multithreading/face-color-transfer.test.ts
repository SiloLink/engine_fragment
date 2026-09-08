import { expect, it } from "vitest";
import { MultithreadingHelper } from "./multithreading-helper";
import { TileRequestClass } from "../model/model-types";
import { encodeFaceColors } from "../utils/face-color-encoder";

it("transfers realized face colors without detaching canonical face IDs", () => {
  const canonical = new Uint32Array([0x123456, 0xabcdef]);
  const colors = encodeFaceColors(canonical);
  const expected = new Uint32Array(colors.buffer).slice();
  const request = {
    tileRequestClass: TileRequestClass.CREATE,
    faceIds: colors,
    positions: new Float32Array(6),
    indices: new Uint16Array(3),
    normals: new Int16Array(6),
    itemIds: new Uint8Array(8),
    tileData: {},
  };
  const received = structuredClone(request, {
    transfer: MultithreadingHelper.getRequestContent({ list: [request] }),
  });
  expect(colors.byteLength).toBe(0);
  expect(new Uint32Array(received.faceIds.buffer)).toEqual(expected);
  expect(Array.from(canonical)).toEqual([0x123456, 0xabcdef]);
});
