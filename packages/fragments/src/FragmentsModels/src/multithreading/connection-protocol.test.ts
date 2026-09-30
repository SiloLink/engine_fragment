import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { Connection } from "./connection";

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
  vi.useRealTimers();
});

function channel() {
  const result = new MessageChannel();
  channels.push(result);
  return result;
}

it("negotiates before dispatching concurrent model requests", async () => {
  const { port1, port2 } = channel();
  const received: unknown[] = [];
  const main = new Connection(vi.fn());
  const worker = new Connection((input) => {
    received.push(input.modelId);
  });
  main.init(port1 as unknown as MessagePort);
  const a = main.fetch({ modelId: "a" });
  const b = main.fetch({ modelId: "b" });
  // The worker is attached after both requests have been issued.
  worker.init(port2 as unknown as MessagePort);
  await Promise.all([a, b]);
  expect(received).toEqual(["a", "b"]);
});

it("rejects incompatible workers without dispatching model work", async () => {
  const { port1, port2 } = channel();
  const requests: unknown[] = [];
  port2.on("message", (message) => requests.push(message));
  const main = new Connection(vi.fn());
  main.init(port1 as unknown as MessagePort);
  const result = expect(main.fetch({ modelId: "a" })).rejects.toThrow(
    /protocol.*incompatible/i,
  );
  port2.postMessage({ fragmentsProtocol: -1 });
  await result;
  expect(requests.filter((input: any) => input.modelId)).toEqual([]);
  await expect(main.fetch({ modelId: "b" })).rejects.toThrow(
    /protocol.*incompatible/i,
  );
});

it("rejects a silent legacy worker within a bounded time", async () => {
  vi.useFakeTimers();
  const { port1 } = channel();
  const main = new Connection(vi.fn());
  main.init(port1 as unknown as MessagePort);
  const result = expect(main.fetch({ modelId: "a" })).rejects.toThrow(
    /protocol.*timed out/i,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
});

it("rejects a legacy worker that echoes the hello in an RPC error response", async () => {
  const { port1, port2 } = channel();
  port2.on("message", (message) =>
    port2.postMessage({
      ...message,
      toMainThread: true,
      errorInfo: "TypeError: unknown request class",
    }),
  );
  const main = new Connection(vi.fn());
  main.init(port1 as unknown as MessagePort);
  await expect(main.fetch({ modelId: "a" })).rejects.toThrow(
    /protocol.*incompatible/i,
  );
});

it("rejects transport dispatch errors instead of leaving the caller pending", async () => {
  const main = new Connection(vi.fn());
  await expect(main.fetch({ modelId: "a" })).rejects.toThrow(/not initialized/);
});
