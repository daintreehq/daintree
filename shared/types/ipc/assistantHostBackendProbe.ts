/**
 * The result of asking a backend origin what it is.
 *
 * A separate module because both the main-process probe and the renderer readout need
 * the shape, and neither should import the other's implementation to get it.
 */

export interface AssistantBackendVersionInfo {
  serverVersion: string;
  buildSha?: string;
}

/**
 * Why an origin is not usable, when it is not.
 *
 * `not-a-backend` and `http-error` are kept apart deliberately: the first means the
 * address is wrong, the second means the address is right and the service said no. They
 * send a reader to entirely different places.
 */
export type AssistantBackendProbeFailureCode =
  "unreachable" | "redirected" | "not-a-backend" | "http-error";

export type AssistantBackendProbeResult =
  | { reachable: true; version: AssistantBackendVersionInfo }
  | { reachable: false; code: AssistantBackendProbeFailureCode; detail: string };
