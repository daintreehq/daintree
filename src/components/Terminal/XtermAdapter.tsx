import { useCallback, useLayoutEffect, useMemo, useRef, useEffect, useState } from "react";
import type { ITerminalOptions } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AgentState } from "@shared/types/agent";
import { cn } from "@/lib/utils";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";
import { isMac } from "@/lib/platform";
import { TerminalRefreshTier } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { writeTerminalInputOrFleet } from "@/services/terminal/fleetInputRouter";
import { isOptimisticallyClosing } from "@/services/terminal/optimisticPanelClose";
import { useTerminalAppearance } from "@/hooks/useTerminalAppearance";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getXtermOptions } from "@/config/xtermConfig";
import { getSoftNewlineSequence } from "../../../shared/utils/terminalInputProtocol.js";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { useTerminalFileTransfer } from "./useTerminalFileTransfer";
import { getOptionWordJumpSequence } from "./terminalWordNavigation";
import {
  isTerminalClipboardCopyKey,
  isTerminalClipboardPasteKey,
  isTuiReservedKey,
} from "@/services/terminalReservedKeys";

export interface XtermAdapterProps {
  terminalId: string;
  launchAgentId?: string;
  /** Runtime-detected agent identity. Drives agent-specific input protocol
   *  (soft-newline sequences, bracketed paste) when a live agent is running. */
  detectedAgentId?: string;
  /** Live agent lifecycle state. Needed alongside the two agent ids so an
   *  exited agent stops being treated as one — `launchAgentId` is durable and
   *  outlives the process it launched. */
  agentState?: AgentState;
  isInputLocked?: boolean;
  onReady?: () => void;
  onExit?: (exitCode: number) => void;
  onInput?: (data: string) => void;
  /**
   * Fired once per live `attach()`, after the service has been told the
   * terminal is visible. Lets the owning pane re-arm anything that captured an
   * attach generation before this async setup landed (#11445).
   */
  onAttached?: () => void;
  className?: string;
  getRefreshTier?: () => TerminalRefreshTier;
  cwd?: string;
  restoreOnAttach?: boolean;
  hasBottomBar?: boolean;
}

const MIN_CONTAINER_SIZE = 50;

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);

export function XtermAdapter({
  terminalId,
  launchAgentId,
  detectedAgentId,
  agentState,
  isInputLocked,
  onReady,
  onExit,
  onInput,
  onAttached,
  className,
  getRefreshTier,
  cwd,
  restoreOnAttach = false,
  hasBottomBar = false,
}: XtermAdapterProps) {
  // No font-ready Suspense gate: `terminalFontReady` is an unannotated native
  // promise, so `use()` suspended for at least one React cycle on every cold
  // open even when JetBrains Mono was already cached — blanking the pane via the
  // `<Suspense fallback={null}>` in TerminalPane for no benefit. We open against
  // whatever font is resolved; if JBM arrives late, `TerminalInstanceService`
  // repairs the mis-sized grid out-of-band via `repairFontGrid()` (wired once to
  // `onTerminalFontArrivedLate` in its constructor) (#9809).
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const prevDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const exitUnsubRef = useRef<(() => void) | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFitRef = useRef(false);
  const initialFitDoneRef = useRef(false);
  const launchAgentIdRef = useRef(launchAgentId);
  const detectedAgentIdRef = useRef(detectedAgentId);
  const onReadyRef = useRef(onReady);
  const onExitRef = useRef(onExit);
  const onInputRef = useRef(onInput);
  const onAttachedRef = useRef(onAttached);
  const cwdRef = useRef(cwd);

  useLayoutEffect(() => {
    launchAgentIdRef.current = launchAgentId;
    detectedAgentIdRef.current = detectedAgentId;
    onReadyRef.current = onReady;
    onExitRef.current = onExit;
    onInputRef.current = onInput;
    onAttachedRef.current = onAttached;
    cwdRef.current = cwd;
  }, [launchAgentId, detectedAgentId, onReady, onExit, onInput, onAttached, cwd]);

  const stableOnInput = useCallback((data: string) => {
    onInputRef.current?.(data);
  }, []);

  const stableCwdProvider = useCallback(() => cwdRef.current ?? "", []);

  // Store the latest getRefreshTier in a ref to prevent stale closures.
  // This ensures the service always calls the current version of the callback.
  const getRefreshTierRef = useRef(getRefreshTier);
  useLayoutEffect(() => {
    getRefreshTierRef.current = getRefreshTier;
  }, [getRefreshTier]);

  // Create a STABLE proxy function that always calls the latest getRefreshTier.
  // This function's identity never changes, preventing stale closure issues.
  const stableRefreshTierProvider = useCallback(() => {
    return getRefreshTierRef.current ? getRefreshTierRef.current() : TerminalRefreshTier.FOCUSED;
  }, []);

  const {
    fontSize,
    fontFamily,
    performanceMode,
    scrollbackLines,
    projectScrollback,
    effectiveTheme,
    wrapperBackground,
    screenReaderMode: screenReaderEnabled,
  } = useTerminalAppearance();

  // Calculate effective scrollback: performance mode overrides, then project override, then app default
  const effectiveScrollback = useMemo(() => {
    if (performanceMode) {
      return PERFORMANCE_MODE_SCROLLBACK;
    }
    const isAgent = launchAgentId !== undefined;
    const baseScrollback = !isAgent && projectScrollback ? projectScrollback : scrollbackLines;
    return getScrollbackForType(isAgent, baseScrollback);
  }, [performanceMode, scrollbackLines, projectScrollback, launchAgentId]);

  // Alt buffer state for TUI applications (OpenCode, vim, htop, etc.)
  // When in alt buffer, we remove padding and let the TUI fill the entire space
  // Initialize from service to avoid flash of wrong padding on mount
  const [isAltBuffer, setIsAltBuffer] = useState(() =>
    terminalInstanceService.getAltBufferState(terminalId)
  );

  // Attach image paste and file drag-and-drop handlers to the padded wrapper
  // rather than the xterm host: in normal-buffer mode the wrapper adds a 12px
  // gutter that reads as part of the terminal, so listening on the host alone
  // would leave a visible border that silently rejects drops. Paste still
  // intercepts correctly — the wrapper is an ancestor, and the listener is
  // registered in the capture phase. The agent identity decides whether a
  // dropped path arrives as an `@` token or a shell-escaped path (#11574).
  const isDragOverFiles = useTerminalFileTransfer(wrapperRef, {
    terminalId,
    isInputLocked,
    onInput: stableOnInput,
    // The same stable reader the instance service gets, so a drop relativizes
    // its `@file` token against the cwd the terminal is in when it lands.
    cwdProvider: stableCwdProvider,
    launchAgentId,
    detectedAgentId,
    agentState,
  });
  // The hook already withholds the state while locked; this keeps the render
  // side honest if that ever changes.
  const showFileDropOverlay = isDragOverFiles && !isInputLocked;

  const hasVisibleBufferContent = useCallback(() => {
    const managed = terminalInstanceService.get(terminalId);
    if (!managed) return false;

    const buffer = managed.terminal.buffer.active;
    if (buffer.baseY > 0) return true;
    const firstLine = buffer.getLine(0)?.translateToString(true) ?? "";
    return firstLine.trim().length > 0;
  }, [terminalId]);

  const terminalOptions = useMemo(
    () =>
      getXtermOptions({
        fontSize,
        fontFamily,
        scrollback: effectiveScrollback,
        performanceMode,
        theme: effectiveTheme,
        screenReaderMode: screenReaderEnabled,
      }),
    [
      effectiveScrollback,
      performanceMode,
      fontSize,
      fontFamily,
      effectiveTheme,
      screenReaderEnabled,
    ]
  );

  // Appearance changes must not re-run the attach effect — detaching and
  // reattaching every mounted terminal made theme-picker hover previews
  // heavyweight and silently blurred the focused terminal (#9929). The attach
  // effect reads the latest options through this ref instead of closing over
  // `terminalOptions`; `appliedOptionsRef` records what the terminal actually
  // received so the options effect below only forwards real deltas.
  const terminalOptionsRef = useRef(terminalOptions);
  const appliedOptionsRef = useRef<ITerminalOptions | null>(null);
  useLayoutEffect(() => {
    terminalOptionsRef.current = terminalOptions;
  }, [terminalOptions]);

  // Push-based resize handler using ResizeObserver dimensions directly
  const handleResizeEntry = useCallback(
    (entry: ResizeObserverEntry) => {
      const instance = terminalInstanceService.get(terminalId);
      if (instance?.isAttaching) {
        return;
      }

      // Get dimensions from observer (zero DOM reads)
      const rect = entry.contentRect;
      const width = rect.width;
      const height = rect.height;

      // Filter collapsed/zero states and hidden windows (clientWidth/Height return 0 when hidden)
      if (width === 0 || height === 0) return;
      if (width < MIN_CONTAINER_SIZE || height < MIN_CONTAINER_SIZE) return;
      if (document.visibilityState !== "visible") {
        pendingFitRef.current = true;
        return;
      }

      const dims = terminalInstanceService.resize(terminalId, width, height);

      if (dims) {
        prevDimensionsRef.current = dims;
      }
    },
    [terminalId]
  );

  // Fallback fit for initial mount and visibility changes. Uses a ref to
  // break the RAF self-reference — the React Compiler rejects accessing
  // `performFit` before its declaration, so the retry reads the latest
  // performFit via performFitRef.current instead.
  const performFitRef = useRef<(() => void) | null>(null);
  const performFit = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (container.clientWidth === 0 || container.clientHeight === 0) {
      if (document.visibilityState !== "visible") {
        pendingFitRef.current = true;
        return;
      }
      // Retry on next frame for drag/mount transitions where container isn't sized yet
      requestAnimationFrame(() => {
        if (containerRef.current) performFitRef.current?.();
      });
      return;
    }

    // Container has no padding (padding is on wrapper), so use clientWidth/Height directly
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width < MIN_CONTAINER_SIZE || height < MIN_CONTAINER_SIZE) return;

    const dims = terminalInstanceService.resize(terminalId, width, height, {
      immediate: true,
    });
    if (dims) {
      prevDimensionsRef.current = dims;
      initialFitDoneRef.current = true;
    }
  }, [terminalId]);
  useEffect(() => {
    performFitRef.current = performFit;
  }, [performFit]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    // Captured inside the async setup below and read by the synchronous cleanup
    // closure. Stays undefined if the component unmounts before attach runs —
    // detach()/setVisible() both tolerate the never-attached state.
    let attachGen: number | undefined;

    // getOrCreate is async because the lazy Unicode11 addon (#10840) is awaited
    // during terminal construction. Run the attach sequence in an IIFE and guard
    // every post-await step with `disposed` so a fast unmount during the addon
    // load can't attach a terminal whose cleanup has already run.
    void (async () => {
      const managed = await terminalInstanceService.getOrCreate(
        terminalId,
        launchAgentId,
        terminalOptionsRef.current,
        stableRefreshTierProvider,
        stableOnInput,
        stableCwdProvider
      );
      if (disposed) return;
      // getOrCreate applies the current options itself (creation or its internal
      // updateOptions call for existing instances) — record them so the options
      // effect doesn't re-apply the same values on this commit.
      appliedOptionsRef.current = terminalOptionsRef.current;

      const wasDetachedForSwitch = managed.isDetached === true;
      const hasSavedTargetDims = !!(managed.targetCols && managed.targetRows);
      managed.isAttaching = true;

      terminalInstanceService.attach(terminalId, container);
      attachGen = terminalInstanceService.getAttachGeneration(terminalId);
      // Force visibility immediately on mount - don't wait for IntersectionObserver.
      // This prevents data from being dropped during the brief window before the observer fires.
      terminalInstanceService.setVisible(terminalId, true);
      // Announce the generation this attach produced. The pane's visibility
      // observer captured one before this async setup resumed, and only the
      // service flag was forced above — the store field it owns would otherwise
      // stay frozen behind the stale capture (#11445).
      onAttachedRef.current?.();

      if (!managed.keyHandlerInstalled) {
        const writeWordJump = (event: KeyboardEvent, sequence: string): boolean => {
          event.preventDefault();
          event.stopPropagation();
          if (!managed.isInputLocked) {
            writeTerminalInputOrFleet(terminalId, sequence);
            // `return false` bypasses xterm's onData, so the listener-installed
            // input tracking is replicated here (#8255). The payload stays empty
            // on purpose: a cursor jump composes no text, and a non-empty one
            // would count toward the agent's composition total.
            terminalInstanceService.notifyUserInput(terminalId);
            stableOnInput(sequence);
          }
          return false;
        };

        const customKeyEventHandler = (event: KeyboardEvent): boolean => {
          // Only process keydown events to avoid double-firing
          if (event.type !== "keydown") {
            return true;
          }

          // Get normalized key for modifier-only detection
          const normalizedKey = keybindingService.normalizeKeyForBinding(event);
          const isModifierOnly = MODIFIER_KEYS.has(normalizedKey);

          // Don't process modifier-only keypresses
          if (isModifierOnly) {
            return true;
          }

          // During IME/voice composition, let xterm's CompositionHelper handle the
          // full lifecycle (composed text + \r). keyCode 229 is Chromium's "Process"
          // key signal during active composition where isComposing may not yet be set.
          if (event.isComposing || event.keyCode === 229) {
            return true;
          }

          // Plain Tab and Shift+Tab are terminal input. xterm v6 intentionally
          // leaves key events uncanceled in screen-reader mode, which lets
          // Chromium's native focus traversal run after xterm accepts Tab.
          // Cancel only the DOM/default path; return true so xterm still emits
          // HT for Tab and CSI Z for Shift+Tab.
          if (
            (event.key === "Tab" || event.code === "Tab" || event.keyCode === 9) &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }

          // Bare F11 is Electron's fullscreen accelerator on Linux/Windows. xterm
          // v6 leaves handled keys uncanceled in screen-reader mode, so the event
          // bubbles to the menu accelerator. Cancel the DOM/default path; return
          // true so xterm still emits the F11 sequence to the PTY.
          if (
            (event.key === "F11" || event.code === "F11" || event.keyCode === 122) &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.shiftKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }

          // Only the shell line editor needs the rewrite: it binds ESC b / ESC f
          // to word motion but not the CSI modifier arrows xterm emits for
          // Option+Arrow. A full-screen TUI decodes those arrows itself, so on
          // the alt buffer we leave the key alone rather than handing the app a
          // Meta+B/F it never asked for.
          const wordJumpSequence =
            isMac() && !terminalInstanceService.getAltBufferState(terminalId)
              ? getOptionWordJumpSequence(event)
              : null;

          // Skip repeat events. A held Option+Arrow is the exception — word jump
          // has to keep firing while the key is down — and it resolves here so
          // auto-repeats never reach the chord resolution below, where they could
          // complete or invalidate a pending chord the user never re-pressed.
          if (event.repeat) {
            return wordJumpSequence ? writeWordJump(event, wordJumpSequence) : true;
          }

          // Let Shift+F10 and ContextMenu key bubble to DOM for panel context menu
          if (
            event.key === "ContextMenu" ||
            (event.key === "F10" &&
              event.shiftKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey)
          ) {
            return false;
          }

          // Intercept F6 for macro-region focus cycling before terminal processing
          if (event.key === "F6") {
            return false;
          }

          // Allow critical Ctrl+<key> bindings to reach the TUI before checking global shortcuts
          if (isTuiReservedKey(event)) {
            return true;
          }

          // Windows/Linux terminal clipboard conventions (Ctrl+Shift+C/V,
          // Shift+Insert). Handled before global resolution — Ctrl+Shift+C/V
          // would otherwise resolve to unrelated app bindings on non-mac. The
          // window capture handler reserves the same keys via
          // isTerminalReservedKey so they reach this handler at all.
          if (isTerminalClipboardCopyKey(event)) {
            event.preventDefault();
            event.stopPropagation();
            // Consume even with no selection: falling through would fire an
            // app shortcut the user didn't intend from inside a terminal.
            if (managed.terminal.hasSelection()) {
              navigator.clipboard.writeText(managed.terminal.getSelection()).catch((error) => {
                logError("[XtermClipboard] Copy failed", error);
              });
            }
            return false;
          }
          if (isTerminalClipboardPasteKey(event)) {
            event.preventDefault();
            event.stopPropagation();
            if (!managed.isInputLocked) {
              // terminal.paste() follows the normal typed-input path (onData →
              // PTY + input accounting) and applies bracketed-paste wrapping.
              navigator.clipboard
                .readText()
                .then((text) => {
                  if (text && !managed.isInputLocked) managed.terminal.paste(text);
                })
                .catch((error) => {
                  logError("[XtermClipboard] Paste failed", error);
                });
            }
            return false;
          }

          // Intercept global keybindings before terminal processing
          // Check when: (1) modifier is pressed, OR (2) chord is pending
          const hasModifier = event.metaKey || event.ctrlKey;
          const pendingChord = keybindingService.getPendingChord();
          if (hasModifier || pendingChord) {
            const result = keybindingService.resolveKeybinding(event);
            if (result.shouldConsume) {
              event.preventDefault();
              event.stopPropagation();

              if (result.match) {
                // Dispatch the matched action
                void actionService
                  .dispatch(
                    result.match.actionId as Parameters<typeof actionService.dispatch>[0],
                    undefined,
                    {
                      source: "keybinding",
                    }
                  )
                  .then((dispatchResult) => {
                    if (!dispatchResult.ok) {
                      logError(
                        `[XtermKeybinding] Action "${result.match!.actionId}" failed`,
                        undefined,
                        { error: dispatchResult.error }
                      );
                    }
                  })
                  .catch((error) => {
                    logError("[XtermKeybinding] Unexpected error", error);
                  });
              }
              // Chord prefix consumed to prevent terminal leakage
              return false;
            }
          }

          // Let the OS handle meta combinations (e.g., Cmd+C/V).
          // Paste (Cmd+V) is handled by Electron's native Edit > Paste menu role,
          // which dispatches a paste event that xterm.js processes natively
          // (including bracketed paste mode wrapping).
          // Keep Alt/Option available for word navigation/editing inside the TUI.
          if (event.metaKey) {
            return false;
          }

          // Allow critical Ctrl+<key> bindings to reach the TUI
          if (isTuiReservedKey(event)) {
            return true;
          }

          if (wordJumpSequence) {
            return writeWordJump(event, wordJumpSequence);
          }

          if (
            event.key === "Enter" &&
            event.shiftKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (event.type === "keydown" && !managed.isInputLocked) {
              // "Soft" newline for agent CLIs.
              // Codex CLI commonly expects LF (\n / Ctrl+J) for a newline without submit.
              // Other agent CLIs use the legacy ESC+CR sequence.
              // Soft-newline sequence follows the live process. If a Codex
              // session is currently running, use its sequence even if this
              // terminal was launched as Claude or as a plain shell.
              const softNewline = getSoftNewlineSequence(
                detectedAgentIdRef.current ?? launchAgentIdRef.current
              );
              writeTerminalInputOrFleet(terminalId, softNewline);
              terminalInstanceService.notifyUserInput(terminalId);
              stableOnInput(softNewline);
            }
            return false;
          }

          if (
            (event.key === "Enter" || event.key === "Return" || event.code === "NumpadEnter") &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (event.type === "keydown" && !managed.isInputLocked) {
              const submit = "\r";
              writeTerminalInputOrFleet(terminalId, submit);
              terminalInstanceService.notifyUserInput(terminalId);
              stableOnInput(submit);
              // Plain Enter is a submit. The custom key handler returns `false`
              // before xterm's onKey/onData fire, so the listener-installed
              // onEnterPressed path is bypassed — call it explicitly to close
              // the `directing` synthetic state. No-op when not in directing.
              terminalInstanceService.notifyEnterPressed(terminalId);
            }
            return false;
          }
          return true;
        };

        // Recorded on the instance as well as attached: this effect runs once
        // per mount and does NOT re-run when a poisoned terminal is rebuilt
        // underneath it (#11776), so the service re-attaches this exact handler
        // to the replacement. Without it `keyHandlerInstalled` would stay true
        // against a fresh Terminal that has no handler, and the rebuilt pane
        // would silently stop accepting keyboard input.
        managed.customKeyEventHandler = customKeyEventHandler;
        managed.terminal.attachCustomKeyEventHandler(customKeyEventHandler);
        managed.keyHandlerInstalled = true;
      }

      exitUnsubRef.current = terminalInstanceService.addExitListener(terminalId, (code) => {
        onExitRef.current?.(code);
      });

      if (!wasDetachedForSwitch || !hasSavedTargetDims) {
        performFit();
      }

      if (
        restoreOnAttach &&
        !(wasDetachedForSwitch && hasSavedTargetDims) &&
        !hasVisibleBufferContent()
      ) {
        void terminalInstanceService
          .fetchAndRestore(terminalId)
          .then((restored) => {
            if (disposed) return;
            if (restored) {
              requestAnimationFrame(() => performFit());
            }
          })
          .catch((err) => {
            if (!disposed) logError("Failed to restore terminal buffer", err);
          });
      }

      onReadyRef.current?.();
    })().catch((err) => {
      if (!disposed) logError("[XtermAdapter] Terminal attach failed", err);
    });

    return () => {
      disposed = true;
      // Pass the captured generation so stale dock→grid unmount cleanup
      // doesn't background a terminal that has already been re-attached elsewhere.
      terminalInstanceService.setVisible(terminalId, false, attachGen);

      // Settle pending resizes before unmount. For a panel the user just
      // optimistically closed, *cancel* the pending resize rather than flush
      // it — flushing force-drains queued output and reflows scrollback
      // synchronously inside the close click. Cancelling still clears the
      // job/debounce so no stale resize fires after teardown or on undo.
      if (isOptimisticallyClosing(terminalId)) {
        terminalInstanceService.cancelPendingResize(terminalId);
      } else {
        terminalInstanceService.flushResize(terminalId);
      }

      terminalInstanceService.detach(terminalId, container);

      if (exitUnsubRef.current) {
        exitUnsubRef.current();
        exitUnsubRef.current = null;
      }

      prevDimensionsRef.current = null;
      initialFitDoneRef.current = false;
    };
  }, [
    terminalId,
    launchAgentId,
    performFit,
    stableRefreshTierProvider,
    stableOnInput,
    stableCwdProvider,
    restoreOnAttach,
    hasVisibleBufferContent,
  ]);

  // Apply appearance changes in-place. updateOptions keys on presence
  // ("theme" in options → full-row refresh; any text-metric key → refit and
  // dimension-cache reset), so only the keys that actually changed are
  // forwarded — a theme hover must not refit every mounted terminal, and an
  // unchanged scrollback write must not touch xterm's CircularList. The
  // applied-vs-current check also makes this a no-op on the commits where the
  // attach effect already passed current options to getOrCreate. The five
  // diffed keys are the only runtime-variable outputs of getXtermOptions —
  // everything else is a static BASE_TERMINAL_OPTIONS constant; extend the
  // diff if a new option ever becomes user-configurable.
  useLayoutEffect(() => {
    const applied = appliedOptionsRef.current;
    appliedOptionsRef.current = terminalOptions;
    if (!applied || applied === terminalOptions) return;

    const delta: Partial<ITerminalOptions> = {};
    if (applied.theme !== terminalOptions.theme) delta.theme = terminalOptions.theme;
    if (applied.fontSize !== terminalOptions.fontSize) delta.fontSize = terminalOptions.fontSize;
    if (applied.fontFamily !== terminalOptions.fontFamily) {
      delta.fontFamily = terminalOptions.fontFamily;
    }
    if (applied.screenReaderMode !== terminalOptions.screenReaderMode) {
      delta.screenReaderMode = terminalOptions.screenReaderMode;
    }
    if (applied.scrollback !== terminalOptions.scrollback) {
      delta.scrollback = terminalOptions.scrollback;
    }
    if (Object.keys(delta).length === 0) return;

    terminalInstanceService.updateOptions(terminalId, delta);
  }, [terminalId, terminalOptions]);

  useLayoutEffect(() => {
    terminalInstanceService.setInputLocked(terminalId, !!isInputLocked);
  }, [terminalId, isInputLocked]);

  // Resolve current tier on every render. The provider identity is intentionally
  // stable, while the store state it reads changes as activity/runtime status
  // updates; memoizing by provider identity left stale BACKGROUND policies in
  // place until a focus click changed the callback.
  const currentTier = getRefreshTier ? getRefreshTier() : TerminalRefreshTier.FOCUSED;

  useLayoutEffect(() => {
    // Use the stable proxy to avoid stale closures in the service
    terminalInstanceService.updateRefreshTierProvider(terminalId, stableRefreshTierProvider);
    terminalInstanceService.applyRendererPolicy(terminalId, currentTier);
  }, [terminalId, stableRefreshTierProvider, currentTier]);

  // Refit terminal when window becomes visible again after being hidden.
  // useLayoutEffect ensures the listener is registered synchronously before
  // paint, closing a race on Windows where the hidden→visible transition fires
  // before a useEffect listener would be attached (see #4913).
  useLayoutEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && pendingFitRef.current) {
        pendingFitRef.current = false;
        performFit();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Defense-in-depth: if the hidden→visible transition already fired before
    // this listener was registered, recover immediately.
    if (pendingFitRef.current && document.visibilityState === "visible") {
      pendingFitRef.current = false;
      performFit();
    }

    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [performFit]);

  // Subscribe to alt buffer state changes for TUI applications (OpenCode, vim, htop, etc.)
  // When in alt buffer, we need to sync the container styling
  // Use useLayoutEffect to avoid flash before first paint
  useLayoutEffect(() => {
    const unsubscribe = terminalInstanceService.addAltBufferListener(terminalId, (altBuffer) => {
      setIsAltBuffer(altBuffer);
    });
    return unsubscribe;
  }, [terminalId]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      // On the first non-zero observation, bypass the debounce and fit
      // synchronously. This prevents blank panels on Linux where the
      // compositor commits layout after the initial rAF-based retry in
      // performFit — the 50ms debounce would delay the fit past first paint.
      if (!initialFitDoneRef.current) {
        for (const entry of entries) {
          const instance = terminalInstanceService.get(terminalId);
          if (instance?.isAttaching) continue;

          const rect = entry.contentRect;
          if (rect.width >= MIN_CONTAINER_SIZE && rect.height >= MIN_CONTAINER_SIZE) {
            const dims = terminalInstanceService.resize(terminalId, rect.width, rect.height, {
              immediate: true,
            });
            if (dims) {
              prevDimensionsRef.current = dims;
              initialFitDoneRef.current = true;
              pendingFitRef.current = false;
              // Cancel any pending debounce/rAF from earlier zero-dim observations
              if (resizeDebounceRef.current !== null) {
                clearTimeout(resizeDebounceRef.current);
                resizeDebounceRef.current = null;
              }
              if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
              }
              return;
            }
          }
        }
      }

      // xterm.js v6's DomScrollableElement triggers layout mutations that can
      // re-enter the ResizeObserver synchronously. Debounce with a short delay
      // to let the DOM settle, then sync with the paint cycle via rAF.
      if (resizeDebounceRef.current !== null) {
        clearTimeout(resizeDebounceRef.current);
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }

      // Capture entries for the closure
      const latestEntries = entries;
      resizeDebounceRef.current = setTimeout(() => {
        resizeDebounceRef.current = null;
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          for (const entry of latestEntries) {
            handleResizeEntry(entry);
          }
        });
      }, 50);
    });
    resizeObserver.observe(container);

    return () => {
      if (resizeDebounceRef.current !== null) {
        clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      resizeObserver.disconnect();
    };
  }, [handleResizeEntry, terminalId]);

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "w-full h-full text-text-primary overflow-hidden",
        // Full-screen TUIs run on the alternate buffer, which has no scrollback —
        // `terminal-alt-buffer` hides xterm's overlay scrollbar (see index.css) so
        // it doesn't draw a dead full-height thumb over the TUI.
        isAltBuffer
          ? "terminal-alt-buffer"
          : ["pl-3 pt-3 pb-3 pr-3", !hasBottomBar && "rounded-b-[var(--radius-lg)]"],
        className
      )}
      style={{ backgroundColor: wrapperBackground, contain: "strict" }}
    >
      <div
        ref={containerRef}
        className="w-full h-full min-h-0 min-w-0"
        aria-label="Terminal output"
        aria-keyshortcuts="F6 Shift+F6"
        role="application"
      />
      {/* Drop-target confirmation. Stays mounted so the exit fade can play, and
          is pointer-transparent so it never becomes a drag boundary of its own.
          Decorative: the drag itself is the announcement, and a live region
          inside a role="application" terminal would just be noise. The wrapper's
          `contain: strict` supplies the containing block. */}
      <div
        aria-hidden="true"
        data-visible={showFileDropOverlay ? "true" : "false"}
        className={cn(
          "pointer-events-none absolute inset-0 z-10 flex select-none items-center justify-center",
          "border border-border-strong bg-surface-panel/90",
          "opacity-0 transition-opacity data-[visible=true]:opacity-100"
        )}
        style={{
          transitionDuration: `${showFileDropOverlay ? UI_ENTER_DURATION : UI_EXIT_DURATION}ms`,
          transitionTimingFunction: showFileDropOverlay ? UI_ENTER_EASING : UI_EXIT_EASING,
        }}
      >
        <span className="rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle px-3 py-1.5 text-xs font-medium text-text-primary">
          Drop to insert
        </span>
      </div>
    </div>
  );
}
