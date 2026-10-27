import { useMacroFocusStore } from "@/store/macroFocusStore";

// The way to a recovery takes the keyboard through a palette, a menu or the
// toolbar button that opens one, so focus landing there says nothing about
// which composer the user was working in.
const PASS_THROUGH =
  '[role="dialog"], [role="menu"], [role="toolbar"], [data-radix-popper-content-wrapper]';

let assistantLast = false;

/**
 * Whether the Daintree Assistant was the last place the keyboard worked,
 * overlays and the toolbar aside. The assistant's own focus region clears as
 * soon as a palette opens, so it can't answer this once one has.
 */
export function wasAssistantLastFocused(): boolean {
  return assistantLast;
}

/** Follows where the keyboard works for {@link wasAssistantLastFocused}. Returns the stop. */
export function trackComposerSurface(): () => void {
  if (typeof document === "undefined") return () => {};
  const onFocusIn = (event: FocusEvent) => {
    const el = event.target;
    if (!(el instanceof Element) || el.closest(PASS_THROUGH)) return;
    assistantLast = useMacroFocusStore.getState().refs.get("assistant")?.contains(el) ?? false;
  };
  document.addEventListener("focusin", onFocusIn, true);
  return () => {
    document.removeEventListener("focusin", onFocusIn, true);
    assistantLast = false;
  };
}
