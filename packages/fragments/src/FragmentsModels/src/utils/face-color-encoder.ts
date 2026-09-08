/* eslint-disable no-bitwise */

import * as THREE from "three";

// Hex channels share the same conversion; retain its exact Float32 values.
const color = new THREE.Color();
const channels = Float32Array.from(
  { length: 256 },
  (_, value) => color.set(value).b,
);

export function encodeFaceColors(faceIds: ArrayLike<number>): Float32Array {
  const colors = new Float32Array(faceIds.length * 3);
  for (let i = 0; i < faceIds.length; i++) {
    const id = faceIds[i];
    colors[i * 3] = channels[(id >>> 16) & 255];
    colors[i * 3 + 1] = channels[(id >>> 8) & 255];
    colors[i * 3 + 2] = channels[id & 255];
  }
  return colors;
}
