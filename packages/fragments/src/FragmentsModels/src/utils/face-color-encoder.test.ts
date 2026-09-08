import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { encodeFaceColors } from "./face-color-encoder";

function referenceColors(faceIds: Uint32Array) {
  const color = new THREE.Color();
  const result = new Float32Array(faceIds.length * 3);
  for (let i = 0; i < faceIds.length; i++) {
    color.set(faceIds[i]);
    result.set([color.r, color.g, color.b], i * 3);
  }
  return result;
}

function bits(values: Float32Array) {
  return new Uint32Array(values.buffer, values.byteOffset, values.length);
}

describe("encodeFaceColors", () => {
  it("preserves Color.set Float32 bits for every channel value", () => {
    const faceIds = new Uint32Array(256 * 3);
    for (let channel = 0; channel < 256; channel++) {
      faceIds[channel * 3] = channel * 65536 + 0x3456;
      faceIds[channel * 3 + 1] = 0x120056 + channel * 256;
      faceIds[channel * 3 + 2] = 0x123400 + channel;
    }

    const colors = encodeFaceColors(faceIds);

    expect(colors).toBeInstanceOf(Float32Array);
    expect(bits(colors)).toEqual(bits(referenceColors(faceIds)));
  });

  it("preserves Uint32 wrapping and ignores the high face-ID byte", () => {
    const faceIds = new Uint32Array([
      0x00112233,
      0xff112233,
      0x100000000,
      0xffffffff + 100,
      -1,
      -100,
      0xffffffff,
    ]);
    const original = faceIds.slice();

    const colors = encodeFaceColors(faceIds);

    expect(bits(colors)).toEqual(bits(referenceColors(faceIds)));
    expect(colors.subarray(0, 3)).toEqual(colors.subarray(3, 6));
    expect(faceIds).toEqual(original);
  });

  it("keeps repeated IDs and subarray boundaries in independent outputs", () => {
    const source = new Uint32Array([
      0xffffff, 0x123456, 0x123456, 0xabcdef, 0x123456, 0,
    ]);
    const faceIds = source.subarray(1, 5);
    const first = encodeFaceColors(faceIds);
    const second = encodeFaceColors(faceIds);

    expect(first.length).toBe(faceIds.length * 3);
    expect(bits(first)).toEqual(bits(referenceColors(faceIds)));
    first.fill(0);
    expect(bits(second)).toEqual(bits(referenceColors(faceIds)));
    expect(source).toEqual(
      new Uint32Array([0xffffff, 0x123456, 0x123456, 0xabcdef, 0x123456, 0]),
    );
    expect(encodeFaceColors(new Uint32Array())).toEqual(new Float32Array());
  });
});
