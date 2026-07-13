import type { PanelInstance } from "@shared/types/panel";
import { isAgentFleetActionEligible } from "@/store/fleetEligibility";

/**
 * Pure decision logic for the type-anywhere rescue and the off-screen focus
 * locator (#11134). Kept free of React and store imports so the whole safety
 * matrix is directly testable.
 *
 * The two behaviours are deliberately asymmetric:
 *   - Rescue *consumes* the keystroke and moves focus, so it is gated hard.
 *   - Locate never touches the event; it only reveals where the key already went.
 */

/**
 * Does this keydown qualify as the "plain printable first keystroke" that may
 * initiate routing?
 *
 * `key.length === 1` is the printable test: it accepts letters, digits,
 * punctuation and any single-codepoint character a layout produces, while
 * rejecting every named key ("Enter", "Backspace", "ArrowLeft", "Dead", "F1").
 * Space is excluded separately — it is printable but is far more often a
 * scroll/activate gesture than the start of a prompt.
 *
 * AltGr is the subtle one: on Windows and Linux layouts, AltGr-produced
 * characters (e.g. `@` on a German keyboard) arrive with BOTH `ctrlKey` and
 * `altKey` set, so a naive "no ctrl, no alt" chord test would silently refuse
 * to rescue perfectly ordinary typing for those users. `getModifierState`
 * distinguishes the real AltGr from a hand-held Ctrl+Alt chord.
 */
export function isRescuableKeystroke(e: KeyboardEvent): boolean {
  if (e.repeat) return false;
  // During IME composition the browser/IME owns the event lifecycle; stealing
  // focus mid-composition corrupts the input. keyCode 229 is Chromium's
  // "Process" signal on the first keydown, before `isComposing` flips.
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.key === "Dead") return false;
  if (e.metaKey) return false;

  const isAltGraph = e.getModifierState("AltGraph");
  if (!isAltGraph && (e.ctrlKey || e.altKey)) return false;

  if (e.key.length !== 1) return false;
  if (e.key === " ") return false;

  return true;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Composite widgets that consume bare printable keys for typeahead / quick-nav
 * — a focused menu item eats "r" to jump to the first item starting with "r".
 * Stealing those keys would break menu, listbox and combobox navigation.
 */
const TYPEAHEAD_ROLES = [
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="tree"]',
  '[role="treegrid"]',
  '[role="grid"]',
  '[role="tablist"]',
].join(",");

/**
 * The element the keystroke actually landed on.
 *
 * `document.activeElement` retargets to the shadow *host* when focus is inside
 * a shadow root, which would make a focused shadow-DOM input look like nothing
 * is focused — and the rescue would steal its keystroke. The event's composed
 * path starts at the true focused node, across shadow boundaries.
 */
export function getFocusTarget(e: KeyboardEvent): Element | null {
  const leaf = e.composedPath()[0];
  if (leaf instanceof Element) return leaf;
  return document.activeElement;
}

/**
 * Is the current focus somewhere that legitimately owns the keystroke?
 *
 * "Useful" is deliberately broad: anything that could plausibly be consuming
 * typed characters — a form control, a live editor, an embedded browsing
 * context, a terminal — keeps the key. The rescue only fires for focus that is
 * genuinely inert (document body, a detached element, or the chrome of a
 * read-only panel such as the file viewer).
 *
 * A read-only CodeMirror surface (`contentEditable === "false"` inside
 * `.cm-editor`) is NOT useful: it swallows the keystroke silently, which is
 * exactly the reported failure.
 */
export function hasUsefulFocus(el: Element | null): boolean {
  if (el === null) return false;
  if (!el.isConnected) return false;
  if (el === document.body || el === document.documentElement) return false;

  if (el instanceof HTMLElement && el.isContentEditable) return true;
  // Read the attribute too: `isContentEditable` is a computed property, and an
  // explicit `contenteditable="false"` (a read-only CodeMirror surface) must
  // stay *not* useful — it swallows the key silently.
  const editableAttr = el.getAttribute("contenteditable");
  if (editableAttr !== null && editableAttr !== "false") return true;
  if (EDITABLE_TAGS.has(el.tagName)) return true;
  // Embedded browsing contexts (browser panel, dev preview) own their own input.
  if (el.tagName === "IFRAME" || el.tagName === "WEBVIEW") return true;
  // A terminal owns the key even when it is scrolled off-screen — that is the
  // locator's case, never the rescue's.
  if (el.closest(".xterm") !== null) return true;
  // The hybrid editor itself, focused but not yet reporting contentEditable.
  if (el.closest("[data-hybrid-input-root]") !== null) return true;
  // Menus, listboxes and comboboxes use bare letters for typeahead.
  if (el.closest(TYPEAHEAD_ROLES) !== null) return true;
  // A custom element with a shadow root may host its own focused input that we
  // cannot see from here — refuse rather than risk swallowing its keystroke.
  if (el.shadowRoot !== null) return true;

  return false;
}

/**
 * Modal surfaces own every key while open.
 *
 * Existence, not ancestry: Radix portals dialog content outside the dialog's
 * DOM subtree, so `closest()` from the focused element misses it and the
 * listener would steal keys from an open modal.
 */
export function hasBlockingOverlay(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/** The panel that owns the currently focused DOM node, if any. */
export function findPanelIdForElement(el: Element | null): string | null {
  const host = el?.closest("[data-panel-id]");
  return host?.getAttribute("data-panel-id") ?? null;
}

export interface RescueContext {
  panelsById: Record<string, PanelInstance>;
  panelIds: string[];
  /** `terminalId` of the last agent the user actually typed into, if any. */
  lastTypedTerminalId: string | null;
  /** Panels mid-voice-submit: the editor is read-only and submits asynchronously. */
  voiceSubmittingIds: ReadonlySet<string>;
  /**
   * The global hybrid-input setting. With it off, `shouldShowHybridInputBar`
   * renders no draft bar for ANY panel — routing a character into a draft
   * nothing displays would silently eat it, which is the exact bug being fixed.
   */
  hybridInputEnabled: boolean;
  /** False while the PTY backend is disconnected or recovering — every editor is disabled then. */
  isBackendReady: boolean;
}

/**
 * Resolve the single agent a rescued keystroke may be routed into, or `null`
 * to refuse.
 *
 * The issue's contract is "refuse to guess when there isn't exactly one
 * plausible target". Operationally:
 *
 *  1. A recorded last-typed agent IS the one plausible target even with other
 *     agents open — real typing history disambiguates it.
 *  2. If that known target exists but cannot currently take input, refuse.
 *     Falling through to a different agent would route the user's prompt to an
 *     agent they never chose, which is the exact harm being fixed.
 *  3. With no history yet (fresh session), fall back to the sole open agent —
 *     with one agent there is nothing to guess between, and this is precisely
 *     the first-use case the feature exists to serve.
 *  4. Zero or multiple candidates with no history: refuse.
 *
 * A target is only routable if its draft would actually be *visible and
 * editable*. Routing into a bar that is switched off, disabled, locked or
 * restarting would drop the character into an invisible draft — the same
 * silent loss the rescue exists to prevent, just one layer deeper.
 */
export function resolveRescueTarget(ctx: RescueContext): string | null {
  // Both of these disable every agent's editor at once, so there is no target
  // worth resolving.
  if (!ctx.hybridInputEnabled) return null;
  if (!ctx.isBackendReady) return null;

  const isRoutable = (id: string): boolean => {
    if (ctx.voiceSubmittingIds.has(id)) return false;
    const panel = ctx.panelsById[id];
    // Agent identity + live PTY + grid location. Excludes raw shells (no agent
    // identity — routing a draft there would execute on Enter against a shell),
    // exited panels, and dock/background panels.
    if (!isAgentFleetActionEligible(panel)) return false;
    // Mirrors `isHybridInputDisabled` in TerminalPane: a locked or restarting
    // editor is read-only, and focus would fall back to the raw xterm.
    if (panel.isInputLocked === true) return false;
    if (panel.isRestarting === true) return false;
    return true;
  };

  if (ctx.lastTypedTerminalId !== null) {
    return isRoutable(ctx.lastTypedTerminalId) ? ctx.lastTypedTerminalId : null;
  }

  // `isRoutable` already requires a live agent PTY panel — no separate kind check.
  const candidates = ctx.panelIds.filter(isRoutable);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
