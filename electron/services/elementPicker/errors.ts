/**
 * Why a resolve produced no response at all. Kept apart from
 * `UnavailableReason`, which describes a candidate: a host that crashed did
 * not find a file missing, and reporting it as one would be a lie about the
 * source.
 */
export type ElementPickerHostErrorCode =
  | "INVALID_REQUEST"
  | "UNKNOWN_WORKSPACE"
  /** Every slot is taken and the queue is full; the caller may ask again. */
  | "HOST_BUSY"
  | "HOST_START_FAILED"
  /** The process serving the job exited, or stopped answering, before it replied. */
  | "HOST_CRASHED"
  | "HOST_DISPOSED"
  /** A resolver threw, failed to load, or answered with something that is not a response. */
  | "RESOLVER_FAILED";

export class ElementPickerHostError extends Error {
  constructor(
    readonly code: ElementPickerHostErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "ElementPickerHostError";
  }
}
