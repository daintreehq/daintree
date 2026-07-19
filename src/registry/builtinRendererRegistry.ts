import { useEffect, type ComponentType } from "react";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

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
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- slot props vary per consumer; the cast site at getBuiltinView() preserves type safety
type AnyComponent = ComponentType<any>;

interface SlotEntry {
  component: AnyComponent;
  /** Owning plugin id (manifest name). Slots registered without one are never gated. */
  pluginId: string | null;
}

const REGISTRY = new Map<string, SlotEntry>();

/** Slot ids already warned about (dev-mode), so a typo'd ref warns once, not per render. */
const warnedMissingSlots = new Set<string>();

export function registerBuiltinView(
  slotId: string,
  component: AnyComponent,
  opts?: { pluginId?: string }
): void {
  if (REGISTRY.has(slotId)) {
    console.warn(`[builtinRendererRegistry] Slot "${slotId}" already registered, overwriting`);
  }
  REGISTRY.set(slotId, { component, pluginId: opts?.pluginId ?? null });
}

export function unregisterBuiltinView(slotId: string): boolean {
  return REGISTRY.delete(slotId);
}

function resolveSlot<P>(
  slotId: string,
  disabledPluginIds: ReadonlySet<string>
): ComponentType<P> | null {
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
  return entry.component as ComponentType<P>;
}

/**
 * Non-reactive resolution — reads the current disabled set once. For callers
 * outside React render; components should use {@link useBuiltinView} so a
 * live plugin toggle re-renders them.
 */
export function getBuiltinView<P>(slotId: string): ComponentType<P> | null {
  return resolveSlot<P>(slotId, usePluginRuntimeStore.getState().disabledPluginIds);
}

/**
 * Reactive slot resolution: re-renders when the owning plugin is enabled or
 * disabled at runtime. Also initializes the plugin-runtime mirror on first
 * mount (idempotent), so any slot consumer is enough to start tracking.
 */
export function useBuiltinView<P>(slotId: string): ComponentType<P> | null {
  const disabledPluginIds = usePluginRuntimeStore((s) => s.disabledPluginIds);
  const init = usePluginRuntimeStore((s) => s.init);
  useEffect(() => init(), [init]);
  return resolveSlot<P>(slotId, disabledPluginIds);
}

export function __resetBuiltinRendererRegistryForTests(): void {
  REGISTRY.clear();
  warnedMissingSlots.clear();
}
