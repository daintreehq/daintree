// Apart from mount.ts so the Playwright fixtures can read them in Node without
// reaching React.

/** Attribute the page's readiness is published on: `ready` or `failed`, absent while pending. */
export const PREVIEW_READY_ATTRIBUTE = "data-daintree-preview-ready";
/** Why the preview failed, beside {@link PREVIEW_READY_ATTRIBUTE}`="failed"`. */
export const PREVIEW_FAILURE_ATTRIBUTE = "data-daintree-preview-failure";
