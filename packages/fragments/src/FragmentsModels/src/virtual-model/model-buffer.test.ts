import pako from "pako";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditRequestType, EditUtils } from "../../../index";
import { MultiThreadingRequestClass } from "../model/model-types";
import { ThreadModelCreator } from "../multithreading/thread-controllers/thread-model-creator";
import { SingleThreadedFragmentsModel } from "../single-threading";
import { VirtualFragmentsModel } from "./virtual-fragments-model";

const disposals: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});

function modelBytes() {
  const model = EditUtils.getModelFromBuffer(
    EditUtils.newModel({ raw: true }),
    true,
  );
  return EditUtils.edit(
    model,
    [
      {
        type: EditRequestType.CREATE_ITEM,
        localId: 42,
        data: { data: { Name: "Buffer ownership" }, category: "IFCWALL" },
      },
    ],
    { raw: true },
  ).model;
}

function loadVirtual(bytes: ArrayBuffer | Uint8Array) {
  const model = new VirtualFragmentsModel("buffer", bytes, undefined as any);
  disposals.push(() => model.dispose());
  return model;
}

describe("Fragments model buffer ownership", () => {
  it("reads an owned byte view without copying or including adjacent bytes", () => {
    const raw = modelBytes();
    const padded = new Uint8Array(raw.byteLength + 32).fill(0xff);
    padded.set(raw, 16);
    const view = padded.subarray(16, 16 + raw.byteLength);
    const model = loadVirtual(view);

    expect(model.getLocalIds()).toContain(42);
    expect(model.data.bb!.bytes().buffer).toBe(padded.buffer);
    expect(model.data.bb!.bytes().byteOffset).toBe(16);
    expect(model.data.bb!.bytes().byteLength).toBe(raw.byteLength);
  });

  it("continues to read an owned ArrayBuffer without copying", () => {
    const raw = new Uint8Array(modelBytes()).buffer;
    const model = loadVirtual(raw);
    expect(model.getLocalIds()).toContain(42);
    expect(model.data.bb!.bytes().buffer).toBe(raw);
  });

  it("aligns unaligned input so generated typed-vector readers remain valid", () => {
    const raw = modelBytes();
    const padded = new Uint8Array(raw.byteLength + 6).fill(0xff);
    padded.set(raw, 3);
    const model = loadVirtual(padded.subarray(3, 3 + raw.byteLength));
    expect(Array.from(model.data.localIdsArray()!)).toContain(42);
    expect(model.data.bb!.bytes().buffer).not.toBe(padded.buffer);
  });

  it("retains the worker's decompressed allocation through setup", async () => {
    const raw = modelBytes();
    const compressed = pako.deflate(raw);
    const inflated = new Uint8Array(raw);
    vi.spyOn(pako, "inflate").mockReturnValue(inflated);
    const thread = {
      actions: {} as Record<number, (input: any) => Promise<void>>,
      loading: new Set<string>(),
      aborting: new Set<string>(),
      list: new Map<string, VirtualFragmentsModel>(),
      connection: { fetch: vi.fn(), fetchMeshCompute: vi.fn() },
      controllerManager: {
        updater: { start: vi.fn(), setUpdateDelay: vi.fn() },
      },
    };
    new ThreadModelCreator(thread as any);
    const input = { modelId: "inflated", modelData: compressed, raw: false };
    await thread.actions[MultiThreadingRequestClass.CREATE_MODEL](input);
    const model = thread.list.get("inflated")!;
    disposals.push(() => model.dispose());

    expect(model.getLocalIds()).toContain(42);
    expect(model.data.bb!.bytes().buffer).toBe(inflated.buffer);
    expect(input.modelData).toBeUndefined();
    expect(thread.loading.size).toBe(0);
  });

  it("reuses decompressed bytes in the single-threaded loader", () => {
    const raw = modelBytes();
    const compressed = pako.deflate(raw);
    vi.spyOn(pako, "inflate").mockReturnValue(raw);
    const model = new SingleThreadedFragmentsModel(
      "compressed",
      compressed,
      false,
    );
    disposals.push(() => model.dispose());

    expect(model.getLocalIds()).toContain(42);
    expect((model as any)._virtualModel.data.bb.bytes().buffer).toBe(
      raw.buffer,
    );
  });

  it("keeps caller-owned raw bytes isolated in the public single-threaded loader", () => {
    const raw = modelBytes();
    const model = new SingleThreadedFragmentsModel("raw", raw, true);
    disposals.push(() => model.dispose());
    raw.fill(0);

    expect(model.getLocalIds()).toContain(42);
    expect(model.getCategories()).toContain("IFCWALL");
  });
});
