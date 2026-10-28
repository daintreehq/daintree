import { sveltekitProjectAdapter } from "./sveltekit/registration.js";
import type { ProjectAdapterRegistration } from "./types.js";

/**
 * The project adapters the host consults, in order; the first to detect an
 * app describes it. A registration is detection and a loader only: what an
 * adapter brings loads behind `load()`, for an app it detected.
 */
export const PROJECT_ADAPTERS: readonly ProjectAdapterRegistration[] = [sveltekitProjectAdapter];
