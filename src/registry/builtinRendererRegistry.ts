import { createElement, useEffect, type ComponentType } from "react";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Slot registry for renderer-side views contributed by built-in plugins. The
 * registry exists so host-owned surfaces (NewWorktreeDialog, SidebarContent,
 * CodeForgeSettingsTab, ForgeStatsToolbarButton) can render plugin-contributed
 * components without importing them directly, preserving the plugin boundary.
 * Slot ids are dot-namespaced by plugin (`github.bulkCreateWorktreeDialog`) so
 * the host can grep the seam.
 *
 * Why this is separate from `contributes.views` / `PluginViewContent` rather
 * than folded into them (#11244): that path resolves a view's `componentPath`
 * to a `plugin://{id}/{path}` URL and lazy-imports it, which requires the
 * plugin to ship its renderer as a separately built bundle. Built-in renderer
 * entries are compiled into the *host* bundle — `builtinPluginRenderers.ts`
 * eagerly globs them for their registration side effects, and they import host
 * modules directly (`@/components/...`, `@/store/...`). There is no
 * `plugin://` module to import, so the standard loader cannot reach them.
 *
 * Folding the two together therefore needs more than a manifest change: either
 * the built-ins get a standalone build boundary (severing those host imports
 * through the SDK/import map), or the view-resolution path learns to resolve
 * host-bundled components in-process. Until one of those lands, this registry
 * is the seam, and `forgeProviders.slots` refs stay unvalidated against it —
 * the main process cannot see the renderer bundle. The
 * `builtinViewRegistrations` test is what keeps the two halves honest.
 *
 * Registration is unconditional, but resolution is enable-aware: a slot
 * registered with an owning `pluginId` resolves to `null` while that plugin is
 * disabled, so host UI drops plugin-contributed views live with the Preferences
 * toggle. React consumers must use {@link useBuiltinView};
 * {@link getBuiltinView} reads the same gate non-reactively and won't re-render
 * on toggle.
 *
 * {@link useBuiltinView} also wraps what it hands back in a component-variant
 * ErrorBoundary — see {@link guardSlot}.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- slot props vary per consumer; the cast site at getBuiltinView() preserves type safety
type AnyComponent = ComponentType<any>;

interface SlotEntry {
  component: AnyComponent;
  /** Owning plugin id (manifest name). Slots registered without one are never gated. */
  pluginId: string | null;
  /** User-facing name for the slot's error fallback. Falls back to generic copy. */
  label: string | undefined;
}

const REGISTRY = new Map<string, SlotEntry>();

/** Slot ids already warned about (dev-mode), so a typo'd ref warns once, not per render. */
const warnedMissingSlots = new Set<string>();

/**
 * Slot views are plugin-contributed and mostly lazy-loaded, so a rejected chunk
 * import or a render throw inside one is the plugin's failure, not the window's.
 * Without a boundary at this seam the nearest catcher is App's *fullscreen* one:
 * a toolbar dropdown whose chunk 404s takes the whole renderer down with
 * "Daintree hit an unrecoverable error". The component variant keeps the failure
 * inside the slot and offers Try again, which remounts the view — enough for a
 * retryable loader (`@/lib/retryableImport`) to re-issue the import.
 *
 * Cached per slot and rebuilt only when the registered component changes: a
 * fresh wrapper type each render would remount the slot subtree every time.
 */
const guarded = new Map<string, { source: AnyComponent; wrapped: AnyComponent }>();

function guardSlot(slotId: string, entry: SlotEntry): AnyComponent {
  const hit = guarded.get(slotId);
  if (hit && hit.source === entry.component) return hit.wrapped;

  const wrapped = (props: Record<string, unknown>) =>
    createElement(ErrorBoundary, {
      variant: "component",
      componentName: entry.label,
      children: createElement(entry.component, props),
    });
  wrapped.displayName = `BuiltinViewGuard(${slotId})`;

  guarded.set(slotId, { source: entry.component, wrapped });
  return wrapped;
}

export function registerBuiltinView(
  slotId: string,
  component: AnyComponent,
  opts?: { pluginId?: string; label?: string }
): void {
  if (REGISTRY.has(slotId)) {
    console.warn(`[builtinRendererRegistry] Slot "${slotId}" already registered, overwriting`);
  }
  REGISTRY.set(slotId, {
    component,
    pluginId: opts?.pluginId ?? null,
    label: opts?.label,
  });
  guarded.delete(slotId);
}

export function unregisterBuiltinView(slotId: string): boolean {
  guarded.delete(slotId);
  return REGISTRY.delete(slotId);
}

function resolveEntry(slotId: string, disabledPluginIds: ReadonlySet<string>): SlotEntry | null {
  const entry = REGISTRY.get(slotId);
  if (!entry) {
    // The main process can't validate slot refs against this registry, so
    // reaching here means the manifest and the host bundle disagree: an id is
    // declared in `forgeProviders.slots` but its `registerBuiltinView` call is
    // missing (or the renderer entry was tree-shaken out — see the
    // package.json `sideEffects` coupling in builtinPluginRenderers.ts).
    // Dev-only and warn-not-throw: an empty ref is the documented "no slot"
    // sentinel, and a null resolution is defined contract, not an error.
    if (import.meta.env.DEV && slotId.length > 0 && !warnedMissingSlots.has(slotId)) {
      warnedMissingSlots.add(slotId);
      console.warn(
        `[builtinRendererRegistry] No view registered for declared slot "${slotId}" — ` +
          `the plugin's forgeProviders.slots and its registerBuiltinView calls disagree`
      );
    }
    return null;
  }
  if (entry.pluginId !== null && disabledPluginIds.has(entry.pluginId)) return null;
  return entry;
}

/**
 * Non-reactive resolution — reads the current disabled set once, and returns the
 * registered component unguarded. For callers outside React render; components
 * should use {@link useBuiltinView} so a live plugin toggle re-renders them and
 * a failing view can't escalate past its own slot.
 */
export function getBuiltinView<P>(slotId: string): ComponentType<P> | null {
  const entry = resolveEntry(slotId, usePluginRuntimeStore.getState().disabledPluginIds);
  return entry ? (entry.component as ComponentType<P>) : null;
}

/**
 * Reactive slot resolution: re-renders when the owning plugin is enabled or
 * disabled at runtime. Also initializes the plugin-runtime mirror on first
 * mount (idempotent), so any slot consumer is enough to start tracking. The
 * returned component is error-boundaried per {@link guardSlot}.
 */
export function useBuiltinView<P>(slotId: string): ComponentType<P> | null {
  const disabledPluginIds = usePluginRuntimeStore((s) => s.disabledPluginIds);
  const init = usePluginRuntimeStore((s) => s.init);
  useEffect(() => init(), [init]);
  const entry = resolveEntry(slotId, disabledPluginIds);
  return entry ? (guardSlot(slotId, entry) as ComponentType<P>) : null;
}

export function __resetBuiltinRendererRegistryForTests(): void {
  REGISTRY.clear();
  warnedMissingSlots.clear();
  guarded.clear();
}
