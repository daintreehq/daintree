import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import type { PanelViewProps } from "@shared/types/plugin";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BrowserPaneSkeleton } from "@/components/Browser/BrowserPaneSkeleton";
import { ContentFadeIn } from "@/components/ui/ContentFadeIn";
import type { PanelComponentProps } from "@/panels/registry";
import { logWarn } from "@/utils/logger";

function isPluginViewModule(mod: unknown): mod is { default: ComponentType<PanelViewProps> } {
  if (mod === null || typeof mod !== "object") return false;
  const candidate = (mod as { default?: unknown }).default;
  // Accept any React element type — function components, `memo(...)`,
  // `forwardRef(...)`, and lazy/class wrappers are all valid defaults.
  // `memo` and `forwardRef` return objects (typeof === "object"), not
  // functions, so a `typeof === "function"`-only check would reject common
  // optimization patterns.
  return typeof candidate === "function" || (typeof candidate === "object" && candidate !== null);
}

/**
 * Build a per-kind renderer host that lazy-imports the plugin's React module
 * over the `plugin://` protocol and mounts it under an `ErrorBoundary` +
 * `Suspense`. One host instance is created per plugin panel kind during
 * `usePluginPanelKinds` reconciliation — the closure captures the
 * already-resolved `plugin://{pluginId}/{path}` URL stored on the kind's
 * `PanelKindConfig.componentPath`.
 *
 * Lifetime contract:
 *   - On mount the host creates an `AbortController` and passes its signal as
 *     `disposeSignal` to the plugin view.
 *   - The signal aborts when the host React subtree unmounts AND when the
 *     plugin's kind disappears from a `plugin:panel-kinds-changed` broadcast
 *     (the broadcast fires before the main process tears down plugin IPC
 *     handlers, so signal-driven cleanup runs while host APIs are still live).
 *   - On render error the boundary's "Try again" button reloads the module —
 *     a fresh `useMemo` ref produces a new `lazy()` call so `import()` is
 *     re-evaluated rather than returning the cached failed promise.
 *
 * The dev-mode hot-reload mechanism (a versioned query-string) is intentionally
 * scoped to `import.meta.env.DEV`. V8 caches ESM module records by URL string
 * and Chromium has no way to evict an entry (Vite #14438 / Chromium #350426234,
 * unresolved as of 2026), so every dev iteration permanently expands the
 * renderer's module map. Acceptable for dev; never for production.
 */
export function makePluginViewHost(config: PanelKindConfig): ComponentType<PanelComponentProps> {
  const componentPath = config.componentPath;
  const pluginId = config.extensionId;
  const kindId = config.id;
  const displayName = config.name;

  if (!componentPath || !pluginId) {
    // The else-branch of usePluginPanelKinds guards this, but a defensive
    // check here keeps the component contract self-checking — a future caller
    // that bypasses the hook gets an inline warn rather than a confusing
    // runtime error from `import('plugin://undefined')`.
    return function PluginViewHostMisconfigured() {
      return (
        <PluginViewLoadError
          pluginId={pluginId ?? "(unknown)"}
          displayName={displayName}
          message="Plugin view is misconfigured: missing componentPath or pluginId."
        />
      );
    };
  }

  function PluginViewHost(props: PanelComponentProps) {
    const [retryCount, setRetryCount] = useState(0);

    const LazyView = useMemo(
      () =>
        lazy<ComponentType<PanelViewProps>>(async () => {
          const mod: unknown = await import(/* @vite-ignore */ componentPath!);
          if (!isPluginViewModule(mod)) {
            throw new Error(
              `Plugin "${pluginId}" view module at ${componentPath} did not export a default React component`
            );
          }
          return { default: mod.default };
        }),
      // retryCount is the reload key: incrementing it produces a fresh lazy()
      // ref so React re-calls the factory instead of returning the cached
      // (failed) promise. componentPath and pluginId are stable closure
      // captures of the kind config and never change for a given host
      // instance, so listing them keeps `exhaustive-deps` honest without
      // breaking the retry semantics.
      [retryCount, componentPath, pluginId]
    );

    const controllerRef = useRef<AbortController | null>(null);
    if (controllerRef.current === null) {
      controllerRef.current = new AbortController();
    }

    useEffect(() => {
      let disposed = false;
      const electron = typeof window !== "undefined" ? window.electron : undefined;
      const onChanged = electron?.plugin?.onPanelKindsChanged;
      let cleanup: (() => void) | undefined;
      if (onChanged) {
        cleanup = onChanged((payload) => {
          if (disposed) return;
          const stillRegistered = payload.kinds.some((k) => k.id === kindId);
          if (!stillRegistered) {
            // Read the controller through the ref so a retry that swapped in a
            // fresh AbortController is the one that gets aborted. Capturing
            // `controllerRef.current` into a const at effect setup would leave
            // post-retry signals permanently un-aborted on plugin removal.
            controllerRef.current?.abort();
          }
        });
      }
      return () => {
        disposed = true;
        cleanup?.();
        controllerRef.current?.abort();
      };
    }, []);

    const handleReset = (): void => {
      // Create a fresh AbortController for the retry so the new lazy import
      // sees an unaborted signal — the prior controller stays aborted.
      controllerRef.current = new AbortController();
      setRetryCount((c) => c + 1);
    };

    return (
      <ErrorBoundary
        variant="component"
        componentName={`PluginView:${pluginId}.${kindId}`}
        onReset={handleReset}
        resetKeys={[retryCount]}
      >
        <Suspense fallback={<BrowserPaneSkeleton label={`Loading ${displayName}`} />}>
          <ContentFadeIn className="flex flex-col h-full w-full">
            <LazyView
              panelId={props.id}
              pluginId={pluginId!}
              disposeSignal={controllerRef.current!.signal}
            />
          </ContentFadeIn>
        </Suspense>
      </ErrorBoundary>
    );
  }

  PluginViewHost.displayName = `PluginViewHost(${kindId})`;
  return PluginViewHost;
}

interface PluginViewLoadErrorProps {
  pluginId: string;
  displayName: string;
  message: string;
}

function PluginViewLoadError({ pluginId, displayName, message }: PluginViewLoadErrorProps) {
  useEffect(() => {
    logWarn("[PluginViewHost] view configuration error", { pluginId, displayName, message });
  }, [pluginId, displayName, message]);

  return (
    <div
      role="region"
      aria-label="Plugin view unavailable"
      className="flex flex-1 flex-col items-center justify-center gap-2 bg-surface-panel p-6 text-text-muted"
    >
      <p className="text-sm font-medium text-text-primary">{displayName} unavailable</p>
      <p className="max-w-sm text-center text-xs text-text-muted">{message}</p>
    </div>
  );
}
