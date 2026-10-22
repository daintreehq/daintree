import type { ProjectAdapterRegistration } from "./types.js";

/**
 * The project adapters the host consults, in order; the first to detect an
 * app describes it. Empty until the dev preview switches to the core picker
 * (#13886), which registers `sveltekitProjectAdapter` here alongside the
 * framework resolvers. Until then the legacy plugin reads the same project
 * model through its own handlers.
 */
export const PROJECT_ADAPTERS: readonly ProjectAdapterRegistration[] = [];
