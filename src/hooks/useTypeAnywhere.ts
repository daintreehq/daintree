import { useEffect, useRef } from "react";
import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useProjectStore } from "@/store/projectStore";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useTypingLocatorStore } from "@/store/typingLocatorStore";
import { usePaletteStore } from "@/store/paletteStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { UI_PALETTE_EXIT_DURATION, UI_TRANSIENT_HINT_DWELL_MS } from "@/lib/animationUtils";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import {
  findPanelIdForElement,
  getFocusTarget,
  hasBlockingOverlay,
  hasUsefulFocus,
  isRescuableKeystroke,
  resolveRescueTarget,
} from "@/lib/typeAnywhere";

/** Best-effort focus retry budget — the draft is already safe by the time we try. */
const FOCUS_ATTEMPT_FRAMES = 30;

/**
 * How long one locate episode suppresses repeats for the same pane. Matches the
 * locator pill's full on-screen life (TypingLocator clears the label at dwell +
 * exit), so an episode lasts exactly as long as the affordance naming the pane:
 * while the user can still read where their typing is going there is nothing to
 * re-announce, and once it is gone a keystroke still landing off-screen earns a
 * fresh locate.
 */
export const LOCATE_EPISODE_MS = UI_TRANSIENT_HINT_DWELL_MS + UI_PALETTE_EXIT_DURATION;

/**
 * Panel ids are opaque and may contain characters that are not selector-safe,
 * so match on the attribute value rather than interpolating into a selector.
 */
function findElementByAttr(attr: string, value: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    if (el.getAttribute(attr) === value) return el;
  }
  return null;
}

function scrollPanelIntoView(terminalId: string): void {
  const host = findElementByAttr("data-panel-id", terminalId);
  host?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

/** Did DOM focus actually land inside this panel's hybrid input? */
function isFocusInHybridInput(terminalId: string): boolean {
  const root = document.activeElement?.closest("[data-hybrid-input-root]");
  return root?.getAttribute("data-hybrid-input-root") === terminalId;
}

/**
 * Type-anywhere rescue + off-screen focus locator (#11134).
 *
 * One capture-phase listener, two mutually exclusive branches:
 *
 *  - **Locate.** A real terminal owns focus but its pane is scrolled out of the
 *    grid viewport. The destination is legitimate — the user just cannot see it.
 *    Scroll it back, pulse it, name it — once per episode, not once per
 *    keystroke. The event is never touched.
 *
 *  - **Rescue.** Nothing useful owns focus, so the keystroke is about to be
 *    eaten. Route it into the draft of the last agent the user typed to, focus
 *    that draft and reveal the pane. Consumes the event — but only after the
 *    character is durably in the store, so a failed focus handoff can never
 *    lose it.
 *
 * Nothing here submits: the character lands in a draft and Enter stays the
 * user's decision.
 */
export function useTypeAnywhere(): void {
  // Route the body through a ref so the listener is registered exactly once and
  // never churns; all state is read imperatively at event time anyway.
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const focusFrameRef = useRef<number | null>(null);
  const locateEpisodeRef = useRef<{ panelId: string; at: number } | null>(null);

  useEffect(() => {
    handlerRef.current = (e: KeyboardEvent) => {
      if (!isRescuableKeystroke(e)) return;
      // A modal or palette owns every key while open.
      if (hasBlockingOverlay()) return;
      if (usePaletteStore.getState().activePaletteId !== null) return;

      // Not `document.activeElement`: it retargets to the shadow host, which
      // would make a focused shadow-DOM input look inert and get its key stolen.
      const active = getFocusTarget(e);
      const panelStore = usePanelStore.getState();

      // --- Locate: focus is in a real terminal that has scrolled away ---
      if (active?.closest(".xterm") !== null && active !== null) {
        const panelId = findPanelIdForElement(active);
        if (panelId === null) return;
        const panel = panelStore.panelsById[panelId];
        // `isVisible` is the existing per-pane IntersectionObserver signal
        // (TerminalPane), rooted at the grid scroll container. Its rootMargin
        // pre-warms a full row, so this only fires for panes that are
        // meaningfully off-screen — not near-misses.
        if (panel === undefined || panel.isVisible !== false) {
          // The pane is on screen (or gone), so whatever episode was running has
          // ended — the next time it goes off-screen deserves a fresh locate.
          locateEpisodeRef.current = null;
          return;
        }

        // Locating is one action per episode, not per keystroke. Without this
        // the receipt flash on the worktree card re-fires for every character
        // (pingTerminal advances pingSeq unconditionally), which is the same
        // per-keystroke flashing the card's own border flash already guards
        // against (#11445).
        const episode = locateEpisodeRef.current;
        const now = Date.now();
        const elapsed = episode === null ? 0 : now - episode.at;
        if (
          episode !== null &&
          episode.panelId === panelId &&
          // A backward wall-clock step (NTP correction, manual change) must not
          // strand the pane un-locatable until real time catches up.
          elapsed >= 0 &&
          elapsed < LOCATE_EPISODE_MS
        ) {
          return;
        }
        locateEpisodeRef.current = { panelId, at: now };

        scrollPanelIntoView(panelId);
        panelStore.pingTerminal(panelId);
        useTypingLocatorStore
          .getState()
          .showLocator(`Typing into ${getTerminalDisplayTitle(panel, "compact")}`);
        // Deliberately no preventDefault: the keystroke belongs to that
        // terminal and stays exactly where the user aimed it.
        return;
      }

      // --- Rescue: the keystroke is about to go nowhere ---
      if (hasUsefulFocus(active)) return;

      // Screen-reader browse mode uses single letters as quick-nav keys —
      // hijacking them would break navigation outright.
      if (useScreenReaderStore.getState().resolvedScreenReaderEnabled()) return;

      // A live broadcast means a routed draft could silently fan out to every
      // armed agent. One armed id is only a preview, matching the threshold
      // `tryFleetBroadcastFromEditor` uses.
      if (useFleetArmingStore.getState().armedIds.size >= 2) return;

      const workspaceId = getViewWorkspaceId();
      if (workspaceId === null) return;

      const inputStore = useTerminalInputStore.getState();
      const recorded = inputStore.lastTypedAgentTarget;
      // A target claimed by a sibling view must never be routed into from here.
      const lastTypedTerminalId =
        recorded !== null && recorded.workspaceId === workspaceId ? recorded.terminalId : null;

      const targetId = resolveRescueTarget({
        panelsById: panelStore.panelsById,
        panelIds: panelStore.panelIds,
        lastTypedTerminalId,
        voiceSubmittingIds: inputStore.voiceSubmittingPanels,
        hybridInputEnabled: inputStore.hybridInputEnabled,
        isBackendReady: panelStore.backendStatus === "connected",
      });
      if (targetId === null) return;

      const target = panelStore.panelsById[targetId];
      if (target === undefined || !isPtyPanel(target)) return;

      // Persist the character BEFORE consuming the event. Everything after this
      // point is reveal/focus polish — if any of it fails, the keystroke is
      // still safely in the draft rather than eaten.
      const projectId = useProjectStore.getState().currentProject?.id;
      const draft = inputStore.getDraftInput(targetId, projectId);
      inputStore.setDraftInput(targetId, draft + e.key, projectId);
      inputStore.bumpExternalDraftRevision();

      e.preventDefault();
      e.stopPropagation();

      // Reveal the landing site: un-maximize a different pane, surface the tab,
      // then focus. `setFocused` also promotes the target's worktree, which is
      // wanted here — it is what makes the draft visible when the agent lives in
      // a worktree the user isn't currently looking at.
      if (panelStore.maximizedId !== null && panelStore.maximizedId !== targetId) {
        panelStore.exitMaximize();
      }
      panelStore.setPreferredTerminalFocusTarget("hybridInput");
      panelStore.setFocused(targetId);
      scrollPanelIntoView(targetId);
      useTypingLocatorStore
        .getState()
        .showLocator(`Typing into ${getTerminalDisplayTitle(target, "compact")}`);
      // The pill now names the rescue target, so any locate episode it replaced
      // is over — returning to that pane deserves to be announced again.
      locateEpisodeRef.current = null;

      // The pane's own focus effect drives the editor focus, but the editor is a
      // lazy chunk and its worktree may still be mounting — so poll until DOM
      // focus actually lands inside the target's hybrid input rather than
      // trusting any handle's boolean (which reports "a view is mounted", not
      // "focus landed"). Best-effort: the draft is already safe.
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
      let framesLeft = FOCUS_ATTEMPT_FRAMES;
      const settleFocus = () => {
        if (isFocusInHybridInput(targetId)) {
          focusFrameRef.current = null;
          return;
        }
        if (framesLeft-- <= 0) {
          focusFrameRef.current = null;
          return;
        }
        focusPanelInput(targetId);
        focusFrameRef.current = requestAnimationFrame(settleFocus);
      };
      focusFrameRef.current = requestAnimationFrame(settleFocus);
    };
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => handlerRef.current(e);
    window.addEventListener("keydown", listener, { capture: true });
    return () => {
      window.removeEventListener("keydown", listener, { capture: true });
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = null;
      }
    };
  }, []);
}
