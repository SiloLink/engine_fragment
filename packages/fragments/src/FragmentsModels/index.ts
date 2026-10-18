import * as THREE from "three";
import { MeshManager, FragmentsModel } from "./src/model";
import { GeometryCacheBudget } from "./src/model/geometry-cache-budget";

import {
  VirtualModelConfig,
  LoadProgressEvent,
  MultiThreadingRequestClass,
  isRawBuffer,
} from "./src";
import { FragmentsConnection } from "./src/multithreading/fragments-connection";
import { ThreadHandler } from "./src/multithreading/connection-handlers";
import { Event, FRAGMENTS_VERSION } from "../Utils";
import { Editor } from "./src/edit";
import { getBundledWorkerUrl } from "../bundled-worker-url";

export * from "./src";

export interface FragmentsModelsOptions {
  /**
   * If true, creates classic (non-module) workers. Use together with `toClassicWorker()`.
   */
  classicWorker?: boolean;
  /**
   * Maximum bytes of inactive geometry retained for reuse across all models.
   * Defaults to 1,000,000,000 bytes; zero disables retention. This bounds the
   * geometry cache, not visible geometry, source data or graphics-driver memory.
   * Capacity is shared by generated geometry size, independently of worker count.
   */
  maxCachedGeometryBytes?: number;
  /**
   * Effective max worker cap. Defaults to `navigator.hardwareConcurrency - 3`, floored at 2. Set explicitly for CI environments or when you know your workload.
   */
  maxWorkers?: number;
  /**
   * Reserved worker capacity per named thread group. Workers are spawned lazily (nothing is spawned until the first load targets a pool). A model loaded with `threadGroup: "x"` always lands on group "x"'s pool; default-pool loads never touch a reserved worker. The sum of group sizes must leave at least one slot for the default pool, otherwise init throws.
   */
  threadGroups?: Record<string, number>;
}

/**
 * The main class for managing multiple 3D models loaded from fragments files. Handles loading, disposing, updating, raycasting, highlighting and coordinating multiple FragmentsModel instances. This class acts as the main entry point for working with fragments models. A FragmentsModels instance needs a worker to process fragments off the main thread. The recommended way to obtain the worker URL is via the static FragmentsModels.getWorker method, which fetches the version-matched worker from unpkg. Check the method docs for more info.
 */
export class FragmentsModels {
  private static _workerURL: string | null = null;
  private static _workerPromise: Promise<string> | null = null;

  /**
   * Fetches the fragments worker from unpkg for the exact version of this
   * `@thatopen/fragments` package and returns a blob URL you can pass to the
   * `FragmentsModels` constructor. The result is cached, so calling this
   * method more than once is cheap.
   *
   * This is the recommended way to obtain the worker URL — it guarantees the
   * worker version matches the library version and requires no copying of
   * files into your project.
   *
   * @example
   * ```ts
   * const workerURL = await FragmentsModels.getWorker();
   * const fragments = new FragmentsModels(workerURL);
   * ```
   *
   * @returns A blob URL pointing to the fragments worker script.
   */
  static async getWorker(): Promise<string> {
    if (FragmentsModels._workerURL) return FragmentsModels._workerURL;
    if (FragmentsModels._workerPromise) return FragmentsModels._workerPromise;

    FragmentsModels._workerPromise = (async () => {
      const url = `https://unpkg.com/@thatopen/fragments@${FRAGMENTS_VERSION}/dist/Worker/worker.mjs`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch fragments worker from ${url}: ${response.status} ${response.statusText}`,
        );
      }
      const blob = await response.blob();
      const file = new File([blob], "worker.mjs", { type: "text/javascript" });
      const objectURL = URL.createObjectURL(file);
      FragmentsModels._workerURL = objectURL;
      return objectURL;
    })();

    try {
      return await FragmentsModels._workerPromise;
    } catch (error) {
      FragmentsModels._workerPromise = null;
      throw error;
    }
  }

  /**
   * Event triggered when a model is loaded.
   * @event
   * @type {Event<FragmentsModel>}
   */
  readonly onModelLoaded = new Event<FragmentsModel>();

  /**
   * Triggered once per consumed tile slice when scene geometry changes.
   * Hosts can request a render without waiting for a complete view update.
   */
  readonly onTilesUpdated = new Event<void>();

  /**
   * The manager that handles all loaded fragments models.
   * Provides functionality to:
   * - Store and retrieve models by ID
   * - Track model loading/unloading
   * - Coordinate updates across models
   * - Handle model disposal
   */
  models: MeshManager;

  /** Settings that control the behavior of the FragmentsModels system */
  settings = {
    /** Whether to automatically coordinate model positions relative to the first loaded model */
    autoCoordinate: true,
    /** Maximum rate (in milliseconds) at which visual updates are performed */
    maxUpdateRate: 100,
    /** Graphics quality level - 0 is low quality, 1 is high quality */
    graphicsQuality: 0,
    /**
     * @deprecated The polling-based force-flush implementation has
     * been replaced by per-model view completion fences. These
     * knobs are no longer read; kept only to avoid
     * breaking apps that set them.
     */
    forceUpdateRate: 200,
    /** @deprecated See {@link forceUpdateRate}. */
    forceUpdateBuffer: 200,
    /**
     * Interval in milliseconds to flush queued mesh requests from thread to
     * main thread. Set this once at FragmentsModels construction; changing
     * it after a model has been loaded has no effect on already-loaded
     * models (they keep the value they were created with).
     *
     * Default 16 ms (one frame at 60 Hz). The previous 64 ms default
     * left tile updates sitting in the worker's outflow buffer for up
     * to ~1 frame longer than necessary; lowering it tightens the
     * latency between worker work and visible result on every
     * interaction. Apps with very heavy worker output may want to
     * raise this to reduce postMessage frequency.
     */
    meshConnectionRate: 16,
    /**
     * Number of queued mesh requests that triggers an immediate flush.
     * Same setup-time semantics as {@link meshConnectionRate}. Default
     * 4 — bursts of work flush within a frame instead of being
     * pinned to the rate timer.
     */
    meshConnectionThreshold: 4,
    /**
     * Delay in milliseconds between worker-side update loops when work is
     * complete. Note: each worker has a single shared update loop, so when
     * multiple models share a worker (default round-robin pool, or any
     * `threadGroup`), the most recently loaded model's value applies to
     * every model on that worker. Set this once at FragmentsModels
     * construction and treat it as a global tuning knob.
     *
     * Default 32 ms (~30 Hz). The previous 128 ms default left the
     * worker idling for up to ~8 frames between iterations, which on
     * interactive workloads showed up as visible lag between RPC and
     * visual settle. Apps with low-end CPUs may want to raise it to
     * reduce idle-loop overhead.
     */
    threadUpdaterDelay: 32,
  };

  /** Coordinates of the first loaded model, used for coordinate system alignment */
  baseCoordinates: number[] | null = null;

  /** The editor instance for managing model edits and changes */
  editor: Editor;

  private readonly _connection: FragmentsConnection;
  private readonly _geometryCache: GeometryCacheBudget;

  private _progressCallbacks = new Map<
    string,
    (event: LoadProgressEvent) => void
  >();

  private _isDisposed = false;
  private _autoRedrawInterval: any = null;
  private _lastUpdate = 0;
  private _pendingForcedUpdate: Promise<void> | null = null;
  // Handle and resolver of the coalesced forced update, kept so dispose()
  // can cancel the timer and still release whoever is awaiting it.
  private _pendingForcedTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingForcedResolve: (() => void) | null = null;

  /**
   * Creates a new FragmentsModels instance.
   *
   * The recommended way to obtain the worker URL is via {@link FragmentsModels.getWorker},
   * which fetches the version-matched worker from unpkg. See its docs for an example.
   *
   * @param workerURL - The URL of the worker script that will handle the fragments processing. If omitted, it falls back to the worker bundled with the package (only works with bundlers that can resolve `new URL("./Worker/worker.mjs", import.meta.url)`).
   * @param options - Optional configuration.
   */
  constructor(workerURL?: string, options?: FragmentsModelsOptions) {
    this._geometryCache = new GeometryCacheBudget(
      options?.maxCachedGeometryBytes ?? 1_000_000_000,
    );
    const url = workerURL ?? getBundledWorkerUrl();
    const requestEvent = this.newRequestEvent();
    const updateEvent = this.newUpdateEvent();
    this._connection = new FragmentsConnection(requestEvent, url, {
      classicWorker: options?.classicWorker,
      maxWorkers: options?.maxWorkers,
      threadGroups: options?.threadGroups,
    });
    this.editor = new Editor(this, this._connection);
    this.models = new MeshManager(updateEvent);
    this.models.list.onItemDeleted.add(() => {
      if (this.models.list.size !== 0) return;
      this.baseCoordinates = null;
    });
  }

  /**
   * Effective max worker cap for this instance. Surfaces the value derived
   * from `navigator.hardwareConcurrency - 3` (floored at 2) or the explicit
   * `maxWorkers` override passed to the constructor.
   */
  get maxWorkers(): number {
    return this._connection.maxWorkers;
  }

  /**
   * Reserved worker capacity per named thread group, as declared at init.
   * Empty object if no groups were declared.
   */
  get threadGroups(): Record<string, number> {
    return this._connection.threadGroups;
  }

  /**
   * Loads a fragments model from an ArrayBuffer.
   * @param buffer - The ArrayBuffer containing the fragments data to load.
   * @param options - Configuration options for loading the model.
   * @param options.modelId - Unique identifier for the model.
   * @param options.camera - Optional camera to use for model culling and LOD.
   * @param options.viewSize - Optional screen-space size in pixels that LOD uses with `camera`. See {@link FragmentsModel.useCamera}.
   * @param options.clippingPlanes - Optional clipping planes (world space) to cull against. The array is kept by reference and read on every view refresh; see {@link FragmentsModel.useClippingPlanes}.
   * @param options.raw - Whether the buffer is raw (uncompressed) or deflated. If omitted, it is auto-detected from the buffer (see {@link isRawBuffer}).
   * @param options.userData - Optional custom data to attach to the model.
   * @param options.virtualModelConfig - Optional configuration for virtual model setup.
   * @returns Promise resolving to the loaded FragmentsModel instance.
   */
  async load(
    buffer: ArrayBuffer | Uint8Array,
    options: {
      modelId: string;
      camera?: THREE.PerspectiveCamera | THREE.OrthographicCamera;
      /**
       * Screen-space size in pixels that LOD uses with `camera`, usually the
       * larger dimension of the viewport that renders the model. It applies
       * from the first view update after loading. When omitted, LOD uses the
       * larger dimension of the browser window until a size is given through
       * {@link FragmentsModel.useCamera}. Ignored without `camera`.
       */
      viewSize?: number;
      clippingPlanes?: THREE.Plane[];
      raw?: boolean;
      userData?: Record<string, any>;
      virtualModelConfig?: VirtualModelConfig;
      /** Optional callback for receiving loading progress updates. */
      onProgress?: (event: LoadProgressEvent) => void;
      /**
       * Routes the model to a thread group declared at init time. Models
       * sharing a group also share workers, isolated from other groups and
       * from the default pool. Throws if the group was not declared.
       */
      threadGroup?: string;
      /**
       * Keeps the model frozen after loading, so that no view is requested
       * until the caller sets {@link FragmentsModel.frozen} to `false`. A
       * caller that first applies visibility or colors then gets first tiles
       * that already carry that state. Defaults to `false`.
       */
      frozen?: boolean;
    },
  ) {
    // Record the model's group before we issue any worker request so the
    // pool routing in fragments-connection picks the right thread.
    this._connection.setModelThreadGroup(options.modelId, options.threadGroup);

    const virtualModelConfig: VirtualModelConfig = {
      ...options.virtualModelConfig,
      multithreading: {
        meshConnectionRate: this.settings.meshConnectionRate,
        meshConnectionThreshold: this.settings.meshConnectionThreshold,
        threadUpdaterDelay: this.settings.threadUpdaterDelay,
        ...options.virtualModelConfig?.multithreading,
      },
    };

    const model = new FragmentsModel(
      options.modelId,
      this.models,
      this._connection,
      this.editor,
      options.threadGroup,
    );

    let disposed = false;
    const assertActive = () => {
      if (
        this._isDisposed ||
        disposed ||
        this.models.list.get(model.modelId) !== model
      ) {
        throw new Error("Fragments: model disposed while loading");
      }
    };
    model.onBeforeDispose.add(() => {
      disposed = true;
      this._geometryCache.retire(model);
    });
    model.onDisposed.add(() => {
      // Disposal must still succeed if redistribution to another worker fails.
      // The allocator conservatively retains any unconfirmed reservation.
      this._geometryCache.remove(model).catch((error) => {
        if (!this._isDisposed)
          console.warn("Fragments: cache redistribution failed", error);
      });
    });

    if (options.userData) {
      model.object.userData = options.userData;
    }

    // Skip model updates until we have the data set
    model.frozen = true;

    // Bind the camera while the model is frozen, so that the first view
    // update after loading already uses the requested view size.
    if (options.camera) {
      model.useCamera(options.camera, options.viewSize);
    }
    if (options.clippingPlanes) model.useClippingPlanes(options.clippingPlanes);

    model.graphicsQuality = this.settings.graphicsQuality;

    if (options.onProgress) {
      this._progressCallbacks.set(options.modelId, options.onProgress);
    }

    // Auto-detect compression when the caller did not specify it, so a raw or
    // deflated buffer both just work. An explicit `raw` always wins.
    const bytes =
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const raw = options.raw ?? isRawBuffer(bytes);

    try {
      this.models.list.set(model.modelId, model);
      await model._setup(buffer, raw, virtualModelConfig);
      const cacheSize = await model.threads.invoke(
        model.modelId,
        "getGeometryCacheSize",
      );
      assertActive();
      await this._geometryCache.register(model, cacheSize, async (bytes) => {
        await model.threads.invoke(model.modelId, "setGeometryCacheBudget", [
          bytes,
        ]);
        // Worker acknowledgement only means DELETEs reached the queue. Wait
        // until they have been applied before transferring their reservation.
        await this.models.whenIdle();
      });
      assertActive();
      if (this.settings.autoCoordinate) {
        const coordinates = await model.getCoordinates();
        assertActive();
        if (this.baseCoordinates === null) {
          this.baseCoordinates = coordinates;
        } else {
          const [px, py, pz] = coordinates;
          const [baseX, baseY, baseZ] = this.baseCoordinates;
          const transform = new THREE.Vector3(
            baseX - px,
            baseY - py,
            baseZ - pz,
          );
          model.object.position.add(transform);
        }
      }
    } catch (e) {
      this._progressCallbacks.delete(options.modelId);
      // Fully dispose partial state — this tears down the worker thread
      // (if this was the last model on it), clears transferred materials,
      // removes the model object from its parent, and deletes it from the
      // models list. `model.dispose()` is safe on partially-loaded models
      // because the worker-side `DELETE_MODEL` handler is now idempotent.
      try {
        if (!disposed) await model.dispose();
      } catch {
        // Never remove a newer model loaded under the same public ID.
        if (this.models.list.get(model.modelId) === model) {
          this.models.list.delete(model.modelId);
        }
      }
      throw e;
    } finally {
      this._progressCallbacks.delete(options.modelId);
    }

    // Model has all the data, so it can start updating unless the caller
    // keeps it frozen until its state is applied.
    model.frozen = options.frozen ?? false;

    this.onModelLoaded.trigger(model);

    return model;
  }

  /**
   * Disposes of all models managed by this FragmentsModels instance.
   * After calling this method, the FragmentsModels instance should not be used anymore.
   */
  async dispose() {
    this._isDisposed = true;
    this._geometryCache.dispose();
    this.models.dispose();
    if (this._autoRedrawInterval) {
      clearTimeout(this._autoRedrawInterval);
      this._autoRedrawInterval = null;
    }
    if (this._pendingForcedTimer) {
      clearTimeout(this._pendingForcedTimer);
      this._pendingForcedTimer = null;
    }
    if (this._pendingForcedResolve) {
      this._pendingForcedResolve();
      this._pendingForcedResolve = null;
    }
    this._pendingForcedUpdate = null;
    const models = Array.from(this.models.list.values());
    const promises = [];
    for (const model of models) {
      promises.push(model.dispose());
    }
    await Promise.all(promises);
    this.onModelLoaded.reset();
    this.onTilesUpdated.reset();
  }

  /**
   * Disposes of a specific model by its ID.
   * @param modelId - The unique identifier of the model to dispose.
   */
  async disposeModel(modelId: string) {
    const model = this.models.list.get(modelId);
    if (model) {
      await model.dispose();
    }
  }

  /**
   * Aborts an in-flight `load()` for the given model ID. The pending `load()`
   * promise will reject with a `LoadAbortedError` and any partial state
   * (on both the main thread and the worker) is disposed.
   *
   * Has no effect if the model finished loading or isn't currently loading.
   *
   * @param modelId - The unique identifier of the model to abort.
   */
  abort(modelId: string) {
    // Fire-and-forget — the worker sets an abort flag and the in-flight
    // generate() loop throws at its next yield point. The error unwinds
    // through load() and its catch block cleans up on the main thread.
    this._connection.fetch({
      class: MultiThreadingRequestClass.ABORT_MODEL,
      modelId,
    });
  }

  /**
   * Updates all models managed by this FragmentsModels instance.
   * @param force - If true, it will force all the models to finish all the pending requests.
   */
  async update(force = false) {
    if (this._isDisposed) {
      return;
    }
    const now = performance.now();
    const elapsed = now - this._lastUpdate;
    if (elapsed < this.settings.maxUpdateRate) {
      if (!force) {
        // Keep the poll alive: view changes are detected by these
        // periodic checks, so a throttled call must still leave a
        // scheduled one behind. Cheap — no worker traffic happens
        // until a view actually changes.
        this.scheduleNextUpdate();
        return;
      }
      // Forced updates must not be dropped (callers await them as a
      // fence), but they must not bypass the rate limit either: camera
      // controls emit "rest" — and the components layer forces an
      // update on it — on nearly every frame of a programmatic orbit,
      // and each forced refresh is a full re-cull plus an unbounded
      // drain on the main thread. Coalesce every forced call inside
      // the window into one trailing forced update; awaiting callers
      // are released when that one has settled, which covers all the
      // RPCs they could have been waiting for.
      if (!this._pendingForcedUpdate) {
        const delay = this.settings.maxUpdateRate - elapsed + 1;
        this._pendingForcedUpdate = new Promise<void>((resolve, reject) => {
          this._pendingForcedResolve = resolve;
          this._pendingForcedTimer = setTimeout(() => {
            this._pendingForcedTimer = null;
            this._pendingForcedResolve = null;
            this._pendingForcedUpdate = null;
            this.performUpdate(true).then(resolve, reject);
          }, delay);
        });
      }
      return this._pendingForcedUpdate;
    }
    return this.performUpdate(force);
  }

  private async performUpdate(force: boolean) {
    if (this._isDisposed) {
      return;
    }
    this._lastUpdate = performance.now();

    // Update the virtual view for all models. Unforced refreshes are
    // skipped per model when its view is unchanged (no RPC at all);
    // forced ones always dispatch because their FINISH acts as the
    // completion fence for forceUpdateFinish below.
    const modelUpdates: Promise<void>[] = [];
    for (const model of this.models.list.values()) {
      modelUpdates.push(model._refreshView(force));
    }
    await Promise.all(modelUpdates);

    if (force) {
      // Each model must finish its requested view and apply its tile changes.
      await this.models.forceUpdateFinish();
    } else {
      this.models.update();
    }
    this.scheduleNextUpdate();
  }

  /**
   * (Re)schedules the next automatic update. The view-change gating
   * means an idle scene produces no worker messages and thus no
   * FINISH-driven update events, so the loop sustains itself with
   * this timer instead. Skipped when disposed or no models exist —
   * the next model load (or any mesh update event) restarts it.
   */
  private scheduleNextUpdate() {
    if (this._isDisposed || this.models.list.size === 0) {
      return;
    }
    if (this._autoRedrawInterval) {
      clearTimeout(this._autoRedrawInterval);
    }
    const offset = this.settings.maxUpdateRate + 1;
    this._autoRedrawInterval = setTimeout(() => {
      this._autoRedrawInterval = null;
      this.update();
    }, offset);
  }

  private async manageRequest(message: any): Promise<void> {
    if (message.class === MultiThreadingRequestClass.LOAD_PROGRESS) {
      const callback = this._progressCallbacks.get(message.modelId);
      if (callback) {
        callback({
          modelId: message.modelId,
          stage: message.stage,
          progress: message.progress,
        });
      }
      return;
    }
    const model = this.models.list.get(message.modelId);
    if (model) {
      await model.handleRequest(message);
    }
  }

  private newUpdateEvent() {
    return () => {
      // A tile batch can land after dispose(); it must not re-arm the loop.
      if (this._isDisposed) return;
      this.onTilesUpdated.trigger();
      // This limits the maximum update rate to the maxUpdateRate setting
      if (this._autoRedrawInterval) {
        clearTimeout(this._autoRedrawInterval);
      }

      const offset = this.settings.maxUpdateRate + 1;
      this._autoRedrawInterval = setTimeout(() => {
        this._autoRedrawInterval = null;
        this.update();
      }, offset);
    };
  }

  private newRequestEvent() {
    return (request: ThreadHandler) => {
      return this.manageRequest(request);
    };
  }
}
