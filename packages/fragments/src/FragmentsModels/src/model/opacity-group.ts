import type { FragmentsModel } from "./fragments-model";
import type { MaterialManager } from "./material-manager";

/** Options for a set of objects whose opacity can be adjusted without a view update. */
export interface OpacityGroupOptions {
  /** Opacity in the inclusive range 0–1. */
  opacity: number;
  /** Scale original material opacity rather than replace it. Defaults to false. */
  relative?: boolean;
}

export function validateOpacity(opacity: number) {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new RangeError("Fragments: opacity must be between 0 and 1.");
  }
}

/**
 * A model-owned opacity control. Membership changes require the usual Fragments
 * view update; scalar changes update loaded geometry immediately and synchronize
 * the worker for tiles arriving later. Changing opacity does not change object
 * visibility or picking. Colors and the original opacity of each material are
 * preserved when `relative` is enabled.
 *
 * An item's latest group assignment, setOpacity, resetOpacity or resetHighlight
 * owns its opacity. Disposing a group only resets items it still owns. A later
 * setItems call explicitly claims its new membership again.
 */
export class OpacityGroup {
  private _disposed = false;
  private _opacity: number;

  /** @internal Construct through FragmentsModel.createOpacityGroup. */
  constructor(
    private readonly model: FragmentsModel,
    private readonly materials: MaterialManager,
    private readonly id: number,
    options: OpacityGroupOptions,
    private readonly onDispose: () => void,
  ) {
    validateOpacity(options.opacity);
    this._opacity = options.opacity;
    materials.createOpacityGroup(model.modelId, id, options);
  }

  /** Whether the group or its model has been disposed. */
  get isDisposed() {
    return this._disposed;
  }

  get opacity() {
    return this._opacity;
  }

  /** Replace membership. Call FragmentsModels.update afterwards to apply tiles. */
  setItems(localIds: number[]): Promise<void> {
    this.assertActive();
    return this.model.threads.invoke(
      this.model.modelId,
      "setOpacityGroupItems",
      [this.id, localIds],
    ) as Promise<void>;
  }

  /**
   * Update loaded material and LOD bindings synchronously, then acknowledge the
   * scalar on the worker. No object-ID transfer, culling or geometry update is
   * needed. A manually rendered host should request a frame after calling this.
   */
  setOpacity(opacity: number): Promise<void> {
    this.assertActive();
    validateOpacity(opacity);
    this._opacity = opacity;
    this.materials.setOpacityGroupValue(this.model.modelId, this.id, opacity);
    return this.model.threads.invoke(
      this.model.modelId,
      "setOpacityGroupValue",
      [this.id, opacity],
    ) as Promise<void>;
  }

  /** Release still-owned members. Call FragmentsModels.update afterwards. */
  async dispose() {
    if (this._disposed) return;
    await this.model.threads.invoke(this.model.modelId, "removeOpacityGroup", [
      this.id,
    ]);
    this.invalidate();
  }

  /** @internal Model disposal invalidates handles without messaging a dead worker. */
  invalidate(restore = true) {
    if (this._disposed) return;
    this._disposed = true;
    this.materials.removeOpacityGroup(this.model.modelId, this.id, restore);
    this.onDispose();
  }

  private assertActive() {
    if (this._disposed)
      throw new Error("Fragments: opacity group has been disposed.");
  }
}
