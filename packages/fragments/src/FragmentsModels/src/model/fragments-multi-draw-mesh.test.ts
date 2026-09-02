import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ObjectClass } from "./model-types";
import { FragmentsMultiDrawMesh } from "./fragments-multi-draw-mesh";
import { MeshManager } from "./mesh-manager";

describe("FragmentsMultiDrawMesh", () => {
  it("only opts an ordinary mesh into the Fragments renderer fast path", () => {
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      3,
    );
    const index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1);
    geometry.setAttribute("position", positions);
    geometry.setIndex(index);
    geometry.addGroup(0, 3, 0);
    const material = [new THREE.MeshBasicMaterial()];

    const mesh = new FragmentsMultiDrawMesh(geometry, material);

    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.isFragmentsMultiDrawMesh).toBe(true);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.geometry.getAttribute("position")).toBe(positions);
    expect(mesh.geometry.index).toBe(index);
    expect(mesh.geometry.groups).toBe(geometry.groups);
    expect(mesh.material).toBe(material);

    geometry.dispose();
    material[0].dispose();
  });
});

describe("MeshManager multi-draw opt-in", () => {
  it("creates only SHELL tiles as FragmentsMultiDrawMesh instances", () => {
    const manager = new MeshManager(vi.fn());
    const material = new THREE.MeshLambertMaterial();
    vi.spyOn(manager.materials, "getFromRequest").mockReturnValue(material);

    const shell = (manager as any).create({
      objectClass: ObjectClass.SHELL,
      indices: new Uint16Array([0, 1, 2]),
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Int16Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    });

    expect(shell).toBeInstanceOf(FragmentsMultiDrawMesh);
    expect(shell.isFragmentsMultiDrawMesh).toBe(true);

    const lineSentinel = new THREE.Mesh();
    vi.spyOn(manager.lod, "createMesh").mockReturnValue(lineSentinel as never);
    const line = (manager as any).create({ objectClass: ObjectClass.LINE });

    expect(line).toBe(lineSentinel);
    expect(line).not.toHaveProperty("isFragmentsMultiDrawMesh");

    shell.geometry.dispose();
    lineSentinel.geometry.dispose();
    material.dispose();
  });
});
