import { useEffect, useRef, type RefObject } from "react";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import type { HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { useHelpPanelStore, selectSlot } from "@/store/helpPanelStore";
import { usePanelStore, useTerminalInputStore } from "@/store";
import { isAssistantFocused } from "@/store/macroFocusStore";
import { dismissAllTooltips } from "@/lib/tooltipDismissRegistry";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { TABBABLE_SELECTOR } from "@/lib/accessibility";

interface UseHelpPanelRevealFocusOptions {
  panelRef: RefObject<HTMLElement | null>;
  inputBarRef: RefObject<HybridInputBarHandle | null>;
  isOpen: boolean;
  isVisible: boolean;
  focusRequest: number;
  terminalId: string | null;
  terminalExists: boolean;
  terminalSpawnStatus: PtyPanelData["spawnStatus"];
  showHybridInputBar: boolean;
}

export function useHelpPanelRevealFocus({
  panelRef,
  inputBarRef,
  isOpen,
  isVisible,
  focusRequest,
  terminalId,
  terminalExists,
  terminalSpawnStatus,
  showHybridInputBar,
}: UseHelpPanelRevealFocusOptions): void {
  // Element that owned focus when the panel last opened. We restore focus to
  // it on close so keyboard users return to where they were rather than
  // body. Mirrors the pattern in AppDialog/AppPaletteDialog.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // Invalidates any deferred reveal-focus frame whose authorizing effect run has
  // already been torn down. Mirrors HybridInputBar's `focusGenerationRef`
  // (#8487) — a frame that was already dequeued can't be stopped by
  // `cancelAnimationFrame`, so it has to check that it still owns the grab.
  const revealFocusGenerationRef = useRef(0);
  // The last (isOpen, isVisible, focusRequest) tuple whose focus grab actually
  // completed. Tracking *completion* rather than the previous effect setup is
  // what makes the grab survive StrictMode: the first setup schedules a frame,
  // the immediate cleanup cancels it, and the replayed setup must still see an
  // outstanding request. A "previous setup" ref would mark it consumed and the
  // panel would open unfocused (#11472).
  const lastCompletedFocusTriggerRef = useRef<{
    isOpen: boolean;
    isVisible: boolean;
    focusRequest: number;
  } | null>(null);

  // Move keyboard focus into the panel on open and restore it on close.
  // focusRequest re-triggers this effect so repeated Cmd+L presses can
  // re-focus a blurred panel without closing it.
  useEffect(() => {
    const focusTrigger = { isOpen, isVisible, focusRequest };
    const lastCompleted = lastCompletedFocusTriggerRef.current;
    // Only opening, revealing and an explicit focusRequest authorize taking
    // focus away from wherever the user is actually typing. Everything else
    // that re-runs this effect is structural (the terminal appeared, finished
    // spawning, was replaced, or the input bar came and went) and may only
    // re-target focus the assistant already owns.
    const hasNewFocusTrigger =
      lastCompleted === null ||
      lastCompleted.isOpen !== isOpen ||
      lastCompleted.isVisible !== isVisible ||
      lastCompleted.focusRequest !== focusRequest;

    if (isOpen && isVisible) {
      // Only remember a restore target when this run is actually authorized to
      // move focus. A structural re-run that the ownership gate goes on to
      // reject must not overwrite it with whatever unrelated pane the user
      // happens to be typing in.
      const active = document.activeElement;
      if (
        hasNewFocusTrigger &&
        active instanceof HTMLElement &&
        !panelRef.current?.contains(active)
      ) {
        previousFocusRef.current = active;
      }

      const generation = ++revealFocusGenerationRef.current;
      let hybridCompletionRaf: number | null = null;
      // The exact bar we handed a focus request to, so cleanup revokes that one
      // rather than whatever `inputBarRef` happens to point at by then.
      let pendingFocusBar: HybridInputBarHandle | null = null;

      const raf = requestAnimationFrame(() => {
        if (revealFocusGenerationRef.current !== generation) return;

        const state = useHelpPanelStore.getState();
        // The panel can close, or rebind to a different session, between this
        // effect and the frame that runs it. A frame already dequeued when
        // cleanup ran can't be cancelled, so re-read both.
        if (!state.isOpen || selectSlot(state, state.activeSlot).terminalId !== terminalId) return;
        // The global assistant's pane takes the keyboard itself; its terminal is no lane's.
        if (state.globalSelected) return;

        // Ownership is re-checked here, on the final deferred frame, rather
        // than in the effect body — focus can move during the frame boundary,
        // and a decision made one frame ago is exactly the stale authorization
        // that let a background agent-state update yank the caret out of
        // another pane's editor (#11472).
        if (!hasNewFocusTrigger && !isAssistantFocused()) return;

        const completeFocusTrigger = () => {
          if (hasNewFocusTrigger) lastCompletedFocusTriggerRef.current = focusTrigger;
        };

        const current = document.activeElement;
        if (
          (current?.closest?.(".xterm-helper-textarea") || current?.closest?.(".cm-editor")) &&
          panelRef.current?.contains(current)
        ) {
          completeFocusTrigger();
          return;
        }

        // Read the panel non-reactively at execution time. The effect no longer
        // subscribes to the panel object, so this is both the freshest value
        // and the only one that reflects a terminal removed or failed between
        // the effect and this frame.
        const currentTerminal = terminalId
          ? usePanelStore.getState().panelsById[terminalId]
          : undefined;
        const currentTerminalPty =
          currentTerminal && isPtyPanel(currentTerminal) ? currentTerminal : undefined;

        // Ownership is settled by this point, so now — and only now — the
        // remembered preference gets to pick which surface receives focus.
        // Resolving it here rather than letting HybridInputBar's own
        // `preferredTerminalFocusTarget` check veto the grab matters: that
        // check aborts silently, which would leave an authorized open request
        // marked complete with focus still in another pane.
        const bar = inputBarRef.current;
        const focusTarget = getTerminalFocusTarget({
          preferredTarget: usePanelStore.getState().preferredTerminalFocusTarget,
          hasHybridInputSurface: showHybridInputBar && bar !== null,
          isInputDisabled: currentTerminalPty?.isInputLocked === true,
          hybridInputEnabled: useTerminalInputStore.getState().hybridInputEnabled,
        });

        // When an agent terminal is running, focus the surface the preference
        // resolved to, falling back to xterm when the editor can't take it.
        //
        // `focusWithCursorAtEnd()` schedules `view.focus()` inside its own
        // requestAnimationFrame, so we cannot synchronously check
        // `document.activeElement` after calling it. We trust the bar's
        // internal rAF when it reports it scheduled the grab — no xterm
        // fallback in that branch, otherwise CodeMirror would steal focus from
        // xterm one frame later and produce a focus flicker. A `false` return
        // means no editor was mounted (the lazy Suspense window) and nothing
        // was scheduled, so falling through to xterm is safe and still focuses
        // something on a cold open.
        if (
          terminalId &&
          currentTerminal &&
          currentTerminalPty?.spawnStatus !== "missing-cli" &&
          currentTerminalPty?.spawnStatus !== "failed"
        ) {
          if (focusTarget === "hybridInput" && bar) {
            // The bar defers the real `view.focus()` to a frame of its own,
            // which is the LAST frame in this grab — so the last ownership
            // check has to run inside it. We can't edit that shared component,
            // but a frame queued here, before the bar schedules its own, is
            // dequeued ahead of it: it gets to re-read ownership and revoke the
            // grab via `cancelPendingFocus()` when the user has moved on in the
            // gap. Without it a structural retry that was legitimate one frame
            // ago still lands in the other pane's editor (#11472).
            hybridCompletionRaf = requestAnimationFrame(() => {
              if (revealFocusGenerationRef.current !== generation) return;
              if (!hasNewFocusTrigger && !isAssistantFocused()) {
                bar.cancelPendingFocus();
                return;
              }
              completeFocusTrigger();
            });
            pendingFocusBar = bar;
            if (bar.focusWithCursorAtEnd()) return;
            // No editor was mounted, so nothing is pending to guard.
            cancelAnimationFrame(hybridCompletionRaf);
            hybridCompletionRaf = null;
            pendingFocusBar = null;
          }
          peekTerminalService()?.focus(terminalId);
          const after = document.activeElement;
          if (after?.closest?.(".xterm-helper-textarea") && panelRef.current?.contains(after)) {
            completeFocusTrigger();
            return;
          }
        }

        const candidates = panelRef.current?.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR);
        let first: HTMLElement | undefined;
        for (const el of candidates ?? []) {
          if (el.getAttribute("role") === "separator") continue;
          first = el;
          break;
        }
        if (first) {
          first.focus();
        } else {
          panelRef.current?.focus();
        }
        completeFocusTrigger();
      });

      return () => {
        cancelAnimationFrame(raf);
        if (hybridCompletionRaf !== null) cancelAnimationFrame(hybridCompletionRaf);
        // Invalidate any frame this run already handed out, including the one
        // nested inside HybridInputBar — `cancelAnimationFrame` can't reach
        // that one, and without this it lands after the panel closed (#11472).
        revealFocusGenerationRef.current += 1;
        pendingFocusBar?.cancelPendingFocus();
      };
    }

    // Record the closed/hidden tuple so the next open or reveal reads as a new
    // request rather than one already satisfied.
    lastCompletedFocusTriggerRef.current = focusTrigger;

    const el = previousFocusRef.current;
    previousFocusRef.current = null;
    // Hand focus back only if the assistant still had it. Closing a panel the
    // user already left must not drag them out of wherever they went — that is
    // the same steal this effect exists to prevent, just on the way out.
    // `body`/null covers the panel tearing down its focused descendant, which
    // is the normal close path.
    const activeOnClose = document.activeElement;
    const assistantStillOwnedFocus =
      activeOnClose === null ||
      activeOnClose === document.body ||
      panelRef.current?.contains(activeOnClose) === true;
    if (
      el &&
      assistantStillOwnedFocus &&
      document.contains(el) &&
      !panelRef.current?.contains(el)
    ) {
      // Radix opens tooltips on focus as well as hover, so handing focus back
      // to a tooltip trigger — the toolbar assistant button is the usual opener
      // — pops a tooltip nothing is hovering. Same failure the dialog
      // primitives already arm against (#11030); the suppression window is
      // honored by both the tooltip open path and useShortcutHintHover's focus
      // branch, and any real pointerenter clears it, so genuine hovers still
      // teach. Inside the guard on purpose: a restore we decline must not
      // suppress a tooltip the user did ask for.
      dismissAllTooltips();
      el.focus();
    }
    return undefined;
  }, [
    panelRef,
    inputBarRef,
    isOpen,
    isVisible,
    focusRequest,
    terminalId,
    terminalExists,
    terminalSpawnStatus,
    showHybridInputBar,
  ]);
}
