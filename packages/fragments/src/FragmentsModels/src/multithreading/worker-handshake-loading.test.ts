import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { FragmentsModels } from "../../index";

afterEach(() => vi.unstubAllGlobals());

it("releases an incompatible worker and allows a later load to create a new one", async () => {
  const terminated = vi.fn();
  const created = vi.fn();
  vi.stubGlobal("MessageChannel", MessageChannel);
  vi.stubGlobal(
    "Worker",
    class {
      port?: MessagePort;
      constructor() {
        created();
      }
      postMessage(port: MessagePort) {
        this.port = port;
        port.postMessage({ fragmentsProtocol: -1 });
      }
      terminate() {
        terminated();
        this.port?.close();
      }
    },
  );
  const fragments = new FragmentsModels("worker-url");
  for (let i = 0; i < 2; i++) {
    await expect(
      fragments.load(new Uint8Array([1]), { modelId: "model" }),
    ).rejects.toThrow(/protocol.*incompatible/i);
    expect(fragments.models.list.size).toBe(0);
    expect(terminated).toHaveBeenCalledTimes(i + 1);
  }
  expect(created).toHaveBeenCalledTimes(2);
});
