/**
 * Thrown by the preset restart when the assistant's next-fallback move was
 * admitted under its tick and then failed (#17917). The class is the
 * attestation: the bridge reads it off the dispatch error's details to record
 * that the tick, not a dialog, authorized whatever teardown ran. Lives in its
 * own leaf module so the bridge can recognise it without the action graph.
 */
export class OwnFallbackStepFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnFallbackStepFailedError";
  }
}
