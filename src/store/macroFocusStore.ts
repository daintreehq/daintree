import { create } from "zustand";
import { getVisibleTabbableElements } from "@/lib/accessibility";

export type MacroRegion = "grid" | "dock" | "sidebar" | "portal" | "assistant";

const REGION_ORDER: MacroRegion[] = ["grid", "dock", "sidebar", "portal", "assistant"];

interface MacroFocusState {
  focusedRegion: MacroRegion | null;
  visibility: Record<MacroRegion, boolean>;
  refs: Map<MacroRegion, HTMLElement>;
  setRegionRef: (region: MacroRegion, el: HTMLElement | null) => void;
  setVisibility: (region: MacroRegion, visible: boolean) => void;
  cycleNext: () => void;
  cyclePrev: () => void;
  clearFocus: () => void;
}

function getVisibleRegions(visibility: Record<MacroRegion, boolean>): MacroRegion[] {
  return REGION_ORDER.filter((r) => visibility[r]);
}

/**
 * Moves DOM focus into a region, whether or not its ROOT can take focus.
 *
 * A region root is a landmark, and a landmark does not have to be focusable — the
 * assistant's deliberately is not, because a permanently focusable container collapses
 * any selection drag started inside it (see `HelpPanel`). `el.focus()` on such an
 * element is a silent no-op, and the store would then claim a region the keyboard had
 * never actually reached: the caret stays in the pane the user cycled AWAY from, so the
 * next keystroke goes to the wrong surface while the chrome says otherwise.
 *
 * So the root is tried first — regions whose root IS focusable keep exactly their old
 * behaviour — and anything that does not take it falls through to the first thing inside
 * that will. The separator is skipped: every panel's first tabbable is its resize
 * handle, and landing there gives the user a drag control rather than the surface they
 * asked for.
 */
function focusRegionRoot(el: HTMLElement | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  if (el.contains(el.ownerDocument.activeElement)) return;
  for (const candidate of getVisibleTabbableElements(el)) {
    if (candidate.getAttribute("role") === "separator") continue;
    candidate.focus({ preventScroll: true });
    return;
  }
}

export const useMacroFocusStore = create<MacroFocusState>((set, get) => ({
  focusedRegion: null,
  visibility: { grid: true, dock: false, sidebar: true, portal: false, assistant: false },
  refs: new Map(),

  setRegionRef: (region, el) => {
    const { refs } = get();
    if (el) {
      refs.set(region, el);
    } else {
      refs.delete(region);
    }
  },

  setVisibility: (region, visible) => {
    set((state) => {
      if (state.visibility[region] === visible) return state;
      const newVisibility = { ...state.visibility, [region]: visible };
      const newFocused = state.focusedRegion === region && !visible ? null : state.focusedRegion;
      return { visibility: newVisibility, focusedRegion: newFocused };
    });
  },

  cycleNext: () => {
    const { visibility, focusedRegion, refs } = get();
    const visible = getVisibleRegions(visibility);
    if (visible.length === 0) return;

    let next: MacroRegion;
    if (focusedRegion === null) {
      next = visible[0]!;
    } else {
      const idx = visible.indexOf(focusedRegion);
      next = visible[(idx + 1) % visible.length]!;
    }

    set({ focusedRegion: next });
    focusRegionRoot(refs.get(next));
  },

  cyclePrev: () => {
    const { visibility, focusedRegion, refs } = get();
    const visible = getVisibleRegions(visibility);
    if (visible.length === 0) return;

    let prev: MacroRegion;
    if (focusedRegion === null) {
      prev = visible[visible.length - 1]!;
    } else {
      const idx = visible.indexOf(focusedRegion);
      prev = visible[(idx - 1 + visible.length) % visible.length]!;
    }

    set({ focusedRegion: prev });
    focusRegionRoot(refs.get(prev));
  },

  clearFocus: () => {
    if (get().focusedRegion !== null) {
      set({ focusedRegion: null });
    }
  },
}));

/**
 * Returns true when the Daintree Assistant region currently owns keyboard
 * focus — either via explicit macro-region cycling (`focusedRegion` set), or
 * because the document's active element lives inside the registered assistant
 * panel root. Synchronous and safe to call before an `await` (#6959 — guards
 * against panel-creation flows reading stale focus state after a microtask
 * boundary).
 */
export function isAssistantFocused(): boolean {
  const state = useMacroFocusStore.getState();
  if (state.focusedRegion === "assistant") return true;
  if (typeof document === "undefined") return false;
  const ref = state.refs.get("assistant");
  if (!ref) return false;
  return ref.contains(document.activeElement);
}
