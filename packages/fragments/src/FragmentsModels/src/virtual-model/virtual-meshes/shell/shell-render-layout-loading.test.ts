import { describe, expect, it, vi } from "vitest";

describe("SHELL render-layout optimizer loading", () => {
  it("does not initialize WebAssembly when the optimizer module is imported", async () => {
    vi.resetModules();
    const instantiate = vi.spyOn(WebAssembly, "instantiate");

    await import("./shell-render-layout");

    expect(instantiate).not.toHaveBeenCalled();
  });
});
