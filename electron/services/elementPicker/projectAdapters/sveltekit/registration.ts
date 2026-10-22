import type { ProjectAdapterRegistration } from "../types.js";
import { KIT_PACKAGE, declaredDependencies } from "./discovery.js";

/**
 * SvelteKit, for an app that declares `@sveltejs/kit`. Detection reads the
 * manifest the host already has; the route parser and the config readers load
 * behind `load()` only once an app says it is a Kit app.
 */
export const sveltekitProjectAdapter: ProjectAdapterRegistration = {
  id: "sveltekit",
  detects: (manifest) => Object.hasOwn(declaredDependencies(manifest), KIT_PACKAGE),
  load: async () => (await import("./adapter.js")).sveltekitAdapter,
};
