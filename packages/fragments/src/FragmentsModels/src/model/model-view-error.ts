export type ModelViewFailureReason = "view-failed" | "model-removed";

/** A failed view's identity is a contract; its diagnostic message is not. */
export class ModelViewUpdateError extends Error {
  readonly name = "ModelViewUpdateError";

  constructor(
    readonly reason: ModelViewFailureReason,
    readonly modelId: string,
    readonly renderRevision: number,
    readonly cause?: unknown,
  ) {
    super(
      reason === "model-removed"
        ? `Fragments: model removed or replaced: ${modelId}`
        : `Fragments: failed to update the view of model ${modelId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
