type FocusHandler = () => void;

let handler: FocusHandler | null = null;

export function registerFleetComposerFocusHandler(fn: FocusHandler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) {
      handler = null;
    }
  };
}

export function focusFleetComposer(): void {
  handler?.();
}
