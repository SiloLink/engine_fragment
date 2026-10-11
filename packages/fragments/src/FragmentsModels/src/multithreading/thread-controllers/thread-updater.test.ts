import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FragmentsThread } from "../fragments-thread";
import { ThreadUpdater } from "./thread-updater";

describe("ThreadUpdater scheduling", () => {
  let clock: number;
  let updater: ThreadUpdater;
  let models: Map<string, ReturnType<typeof createModel>>;

  function createModel(duration = 0, complete = true) {
    return {
      update: vi.fn(() => {
        clock += duration;
        return complete;
      }),
      failUpdate: vi.fn(),
    };
  }

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    models = new Map();
    updater = new ThreadUpdater({ list: models } as unknown as FragmentsThread);
  });

  afterEach(() => {
    updater.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("gives every model a turn when each update exhausts the tick budget", () => {
    const first = createModel(17, false);
    const second = createModel(17, false);
    models.set("first", first);
    models.set("second", second);

    updater.start();
    for (let tick = 0; tick < 10; tick++) vi.advanceTimersToNextTimer();

    expect(first.update).toHaveBeenCalledTimes(5);
    expect(second.update).toHaveBeenCalledTimes(5);
  });

  it("does not wait for the idle delay while unvisited models may have work", () => {
    const complete = createModel(17);
    const pending = createModel(0, false);
    models.set("complete", complete);
    models.set("pending", pending);

    updater.start();
    vi.advanceTimersToNextTimer();
    expect(complete.update).toHaveBeenCalledOnce();
    expect(pending.update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(pending.update).toHaveBeenCalledOnce();
  });

  it("backs off after a complete sweep and uses the configured idle delay", () => {
    const first = createModel();
    const second = createModel();
    models.set("first", first);
    models.set("second", second);
    updater.setUpdateDelay(40);

    updater.start();
    vi.advanceTimersToNextTimer();
    expect(first.update).toHaveBeenCalledOnce();
    expect(second.update).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(39);
    expect(first.update).toHaveBeenCalledOnce();
    expect(second.update).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(first.update).toHaveBeenCalledTimes(2);
    expect(second.update).toHaveBeenCalledTimes(2);
  });

  it("updates current models after removals, replacements, and additions", () => {
    const first = createModel(17, false);
    const removed = createModel(17, false);
    const replaced = createModel(17, false);
    models.set("first", first);
    models.set("removed", removed);
    models.set("replaced", replaced);
    updater.start();
    vi.advanceTimersToNextTimer();

    const replacement = createModel(17, false);
    const added = createModel(17, false);
    models.delete("removed");
    models.set("replaced", replacement);
    models.set("added", added);
    for (let tick = 0; tick < 3; tick++) vi.advanceTimersToNextTimer();

    expect(removed.update).not.toHaveBeenCalled();
    expect(replaced.update).not.toHaveBeenCalled();
    expect(replacement.update).toHaveBeenCalledOnce();
    expect(added.update).toHaveBeenCalledOnce();
    expect(first.update).toHaveBeenCalledTimes(2);
  });

  it("completes a failed model with its error and keeps updating other models", () => {
    const error = new Error("Cannot update model");
    const failed = createModel();
    failed.update.mockImplementation(() => {
      clock += 17;
      throw error;
    });
    const healthy = createModel(17);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    models.set("failed", failed);
    models.set("healthy", healthy);

    updater.start();
    vi.advanceTimersToNextTimer();
    expect(failed.failUpdate).toHaveBeenCalledExactlyOnceWith(error);
    expect(logError).toHaveBeenCalledExactlyOnceWith(error);
    vi.advanceTimersByTime(1);
    expect(healthy.update).toHaveBeenCalledOnce();
  });

  it("stops with no models and restarts after a model is registered", () => {
    const previous = createModel(17);
    models.set("previous", previous);
    models.set("removed", createModel());
    updater.start();
    updater.start();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersToNextTimer();

    models.clear();
    vi.advanceTimersToNextTimer();
    expect(vi.getTimerCount()).toBe(0);

    const current = createModel();
    models.set("current", current);
    updater.start();
    vi.advanceTimersToNextTimer();
    expect(current.update).toHaveBeenCalledOnce();
    expect(previous.update).toHaveBeenCalledOnce();
    updater.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
