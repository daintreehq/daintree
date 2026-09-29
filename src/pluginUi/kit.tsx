import { createElement, Suspense, use, type ComponentType, type ReactNode } from "react";
import type { PluginKit } from "@/components/PluginKit/PluginKit";

// The adapters sit behind one dynamic import, for the same reason as
// Markdown's: anything this facade imports statically is startup code (see
// vite.config.ts), and the host components pull stores and services with them.
// One module rather than one per component, so a view's first render waits on
// a single chunk and every primitive is synchronous after it.
let loaded: PluginKit | null = null;
let pending: Promise<PluginKit> | null = null;

function loadKit(): Promise<PluginKit> {
  pending ??= import("@/components/PluginKit/PluginKit").then(
    (module) => (loaded = module.pluginKit),
    (error: unknown) => {
      // A failed chunk load is retried by the next render, not cached forever.
      pending = null;
      throw error;
    }
  );
  return pending;
}

// Started as soon as a view imports the kit, so the chunk is usually in by the
// time the view first renders and nothing waits.
loadKit().catch(() => {});

/**
 * A kit component that renders the host adapter `pick` selects once the kit
 * chunk is in. Until then it renders `fallback` (nothing, by default), for a
 * frame at most in practice: the chunk is local and requested at import.
 */
export function fromKit<P extends object>(
  name: string,
  pick: (kit: PluginKit) => ComponentType<P>,
  fallback?: (props: P) => ReactNode
): (props: P) => ReactNode {
  function Loaded(props: P) {
    const kit = loaded ?? use(loadKit());
    return createElement(pick(kit), props);
  }
  function KitComponent(props: P) {
    return (
      <Suspense fallback={fallback ? fallback(props) : null}>
        <Loaded {...props} />
      </Suspense>
    );
  }
  KitComponent.displayName = name;
  return KitComponent;
}
