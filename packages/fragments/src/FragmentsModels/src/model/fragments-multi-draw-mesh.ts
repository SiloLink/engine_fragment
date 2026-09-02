import * as THREE from "three";

/**
 * An ordinary Three.js mesh that opts into the Fragments multi-draw renderer
 * path when the host renderer supports it.
 *
 * Stock Three.js treats this exactly like any other `THREE.Mesh`. The marker
 * intentionally carries no rendering state so geometry, materials, groups,
 * picking, and highlight mutations keep using the existing Fragments paths.
 */
export class FragmentsMultiDrawMesh extends THREE.Mesh {
  readonly isFragmentsMultiDrawMesh = true;
}
