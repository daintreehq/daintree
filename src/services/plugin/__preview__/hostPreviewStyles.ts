import type { PreviewStyleHost } from "@daintreehq/plugin-sdk/testing/preview";
import { createPluginStyleRuntime } from "@/services/plugin/tailwind/pluginStyleRuntime";

export interface HostPreviewStyles extends PreviewStyleHost {
  dispose(): void;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * The host's own plugin style runtime, as the plugin panel preview's style
 * source: the same compiler, design contract and scoping a view gets in
 * Daintree. A failed install is remembered rather than only logged, so the
 * preview reports `failed` instead of capturing a half-styled panel.
 */
export async function createHostPreviewStyles(
  doc: Document = document
): Promise<HostPreviewStyles> {
  let failure: string | null = null;
  const listeners = new Set<() => void>();
  const runtime = await createPluginStyleRuntime(doc, {
    onInstallFailure: ({ phase, error }) => {
      failure ??= `${phase}: ${error}`;
      for (const listener of [...listeners]) listener();
    },
  });
  return {
    registerRoot: (root) => runtime.registerRoot(root),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // The runtime installs from a MutationObserver callback, a microtask after
    // the DOM changed; a frame later it has run and painted.
    settled: nextFrame,
    failure: () => failure,
    dispose: () => {
      listeners.clear();
      runtime.dispose();
    },
  };
}
