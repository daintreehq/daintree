type FocusHandler = () => void;

const registry = new Map<string, FocusHandler>();

export function registerPanelFocusHandler(id: string, handler: FocusHandler): () => void {
  registry.set(id, handler);
  return () => {
    if (registry.get(id) === handler) {
      registry.delete(id);
    }
  };
}

export function focusPanelInput(id: string): void {
  registry.get(id)?.();
}
