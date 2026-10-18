import { afterEach, expect, it, vi } from "vitest";
import { MeshConnection } from "./mesh-connection";
import { Connection } from "./connection";
import { TileRequest } from "./protocol";

const pending = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
afterEach(() => vi.useRealTimers());

it("flush waits for earlier automatic transfers as well as the remaining batch", async () => {
  vi.useFakeTimers();
  const first = pending();
  const last = pending();
  const fetchMeshCompute = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(last.promise);
  const mesh = new MeshConnection(
    "model",
    { fetchMeshCompute } as unknown as Connection,
    { meshConnectionThreshold: 1 },
  );
  const request = {} as TileRequest;
  mesh.process(request);
  mesh.process(request);
  mesh.process(request);
  const done = vi.fn();
  const flushed = mesh.flush().then(done);
  expect(fetchMeshCompute.mock.calls.map(([, list]) => list.length)).toEqual([
    2, 1,
  ]);
  last.resolve();
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  first.resolve();
  await flushed;
  expect(done).toHaveBeenCalledOnce();
  mesh.dispose();
});

it("does not acknowledge a failed transfer that settled before flush", async () => {
  vi.useFakeTimers();
  const failure = new Error("delivery failed");
  const mesh = new MeshConnection(
    "model",
    {
      fetchMeshCompute: () => Promise.reject(failure),
    } as unknown as Connection,
    { meshConnectionThreshold: 0 },
  );
  mesh.process({} as TileRequest);
  await Promise.resolve();
  await expect(mesh.flush()).rejects.toBe(failure);
  mesh.dispose();
});

it("flush has no work or timers without a connection", async () => {
  const mesh = new MeshConnection("model", undefined);
  mesh.process({} as TileRequest);
  await expect(mesh.flush()).resolves.toBeUndefined();
  mesh.dispose();
});
