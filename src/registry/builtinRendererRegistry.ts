import { useEffect, type ComponentType } from "react";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

/**
 * Slot registry for renderer-side views contributed by built-in plugins. The
 * registry exists so host-owned dialogs (NewWorktreeDialog, SidebarContent)
 * can render plugin-contributed components without importing them directly,
 * preserving the plugin boundary while `contributes.views` from the plugin
 * manifest is unimplemented. Slot ids are dot-namespaced by plugin
 * (`github.bulkCreateWorktreeDialog`) so the host can grep the seam.
 *
 * Registration is unconditional (plugin renderer bundles are imported eagerly
 * at app start), but resolution is enable-aware: a slot registered with an
 * owning `pluginId` resolves to `null` while that plugin is disabled, so host
 * UI drops plugin-contributed views live with the Preferences toggle. React
 * consumers must use {@link useBuiltinView}; {@link getBuiltinView} reads the
 * same gate non-reactively and won't re-render on toggle.
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
    // A non-empty ref that was never registered is most likely a plugin-author
    // typo in a `forgeProviders.slots` value — the main process can't validate
    // these against this renderer registry, so surface it here. Dev-only and
    // warn-not-throw: an empty ref is the documented "no slot" sentinel, and a
    // null resolution is defined contract, not an error.
    if (import.meta.env.DEV && slotId.length > 0 && !warnedMissingSlots.has(slotId)) {
      warnedMissingSlots.add(slotId);
      console.warn(
        `[builtinRendererRegistry] No view registered for slot "${slotId}" — ` +
          `check the plugin's forgeProviders.slots ref and registerBuiltinView call`
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
