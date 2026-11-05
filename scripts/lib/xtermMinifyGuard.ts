import type { Plugin } from "vite";

/** Keep xterm's identifier-preservation workaround on the active output minifier. */
export function xtermMinifyIdentifiersGuardPlugin(): Plugin {
  return {
    name: "xterm-minify-identifiers-guard",
    apply: "build",
    configResolved(config) {
      if (config.build.minify !== "oxc" && config.build.minify !== false) {
        throw new Error("The xterm identifier protection requires Oxc or an unminified build.");
      }
    },
    outputOptions(options) {
      const minify = options.minify;
      if (minify === false || minify === "dce-only") return;
      if (typeof minify === "object" && minify.mangle === false) return;
      throw new Error("Identifier mangling must be disabled for xterm's bundled parser.");
    },
  };
}
