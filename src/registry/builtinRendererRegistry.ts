import type { ComponentType } from "react";

/**
 * Slot registry for renderer-side views contributed by built-in plugins. The
 * registry exists so host-owned dialogs (NewWorktreeDialog, SidebarContent)
 * can render plugin-contributed components without importing them directly,
 * preserving the plugin boundary while `contributes.views` from the plugin
 * manifest is unimplemented. Slot ids are dot-namespaced by plugin
 * (`github.bulkCreateWorktreeDialog`) so the host can grep the seam.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- slot props vary per consumer; the cast site at getBuiltinView() preserves type safety
type AnyComponent = ComponentType<any>;

const REGISTRY = new Map<string, AnyComponent>();

export function registerBuiltinView(slotId: string, component: AnyComponent): void {
  if (REGISTRY.has(slotId)) {
    console.warn(`[builtinRendererRegistry] Slot "${slotId}" already registered, overwriting`);
  }
  REGISTRY.set(slotId, component);
}

export function unregisterBuiltinView(slotId: string): boolean {
  return REGISTRY.delete(slotId);
}

export function getBuiltinView<P>(slotId: string): ComponentType<P> | null {
  const component = REGISTRY.get(slotId);
  return (component as ComponentType<P> | undefined) ?? null;
}

export function __resetBuiltinRendererRegistryForTests(): void {
  REGISTRY.clear();
}
