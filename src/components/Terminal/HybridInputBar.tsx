import {
  type KeyboardEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LegacyAgentType } from "@shared/types";
import { getAgentConfig } from "@/config/agents";
import { cn } from "@/lib/utils";
import { buildTerminalSendPayload } from "@/lib/terminalInput";
import { useFileAutocomplete } from "@/hooks/useFileAutocomplete";
import { useSlashCommandAutocomplete } from "@/hooks/useSlashCommandAutocomplete";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { AutocompleteMenu, type AutocompleteItem } from "./AutocompleteMenu";
import { isEnterLikeLineBreakInputEvent } from "./hybridInputEvents";
import {
  formatAtFileToken,
  getAtFileContext,
  getSlashCommandContext,
  type AtFileContext,
  type SlashCommandContext,
} from "./hybridInputParsing";
import { isAgentReady } from "@/store/slices/terminalCommandQueueSlice";

const MAX_TEXTAREA_HEIGHT_PX = 160;

export interface HybridInputBarHandle {
  focus: () => void;
  focusWithCursorAtEnd: () => void;
}

export interface HybridInputBarProps {
  terminalId: string;
  onSend: (payload: { data: string; trackerData: string; text: string }) => void;
  onSendKey?: (key: string) => void;
  onActivate?: () => void;
  cwd: string;
  agentId?: LegacyAgentType;
  agentState?: import("@/types").AgentState;
  agentHasLifecycleEvent?: boolean;
  restartKey?: number;
  disabled?: boolean;
  className?: string;
}

function getTextOffsetLeftPx(textarea: HTMLTextAreaElement, charIndex: number): number {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");

  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflowWrap = "break-word";
  mirror.style.boxSizing = "border-box";

  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.fontWeight = style.fontWeight;
  mirror.style.fontStyle = style.fontStyle;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.lineHeight = style.lineHeight;

  mirror.style.paddingTop = style.paddingTop;
  mirror.style.paddingRight = style.paddingRight;
  mirror.style.paddingBottom = style.paddingBottom;
  mirror.style.paddingLeft = style.paddingLeft;

  mirror.style.width = `${textarea.clientWidth}px`;

  const text = textarea.value.slice(0, Math.max(0, Math.min(charIndex, textarea.value.length)));
  mirror.textContent = text;

  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const markerRect = marker.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();

  document.body.removeChild(mirror);

  return markerRect.left - mirrorRect.left - textarea.scrollLeft;
}

export const HybridInputBar = forwardRef<HybridInputBarHandle, HybridInputBarProps>(
  (
    {
      terminalId,
      onSend,
      onSendKey,
      onActivate,
      cwd,
      agentId,
      agentState,
      agentHasLifecycleEvent = false,
      restartKey = 0,
      disabled = false,
      className,
    },
    ref
  ) => {
    const getDraftInput = useTerminalInputStore((s) => s.getDraftInput);
    const setDraftInput = useTerminalInputStore((s) => s.setDraftInput);
    const clearDraftInput = useTerminalInputStore((s) => s.clearDraftInput);
    const addToHistory = useTerminalInputStore((s) => s.addToHistory);
    const navigateHistory = useTerminalInputStore((s) => s.navigateHistory);
    const resetHistoryIndex = useTerminalInputStore((s) => s.resetHistoryIndex);
    const isInHistoryMode = useTerminalInputStore(
      (s) => (s.historyIndex.get(terminalId) ?? -1) !== -1
    );
    const [value, setValue] = useState(() => getDraftInput(terminalId));
    const allowNextLineBreakRef = useRef(false);
    const handledEnterRef = useRef(false);
    const submitAfterCompositionRef = useRef(false);
    const sendRafRef = useRef<number | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const inputShellRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const barContentRef = useRef<HTMLDivElement | null>(null);
    const [atContext, setAtContext] = useState<AtFileContext | null>(null);
    const [slashContext, setSlashContext] = useState<SlashCommandContext | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const lastQueryRef = useRef<string>("");
    const [menuLeftPx, setMenuLeftPx] = useState<number>(0);
    const [collapsedHeightPx, setCollapsedHeightPx] = useState<number | null>(null);
    const [initializationState, setInitializationState] = useState<"initializing" | "initialized">(
      "initializing"
    );

    const isAgentTerminal = agentId !== undefined;

    useEffect(() => {
      setInitializationState("initializing");
    }, [restartKey]);

    useEffect(() => {
      if (
        initializationState === "initializing" &&
        isAgentTerminal &&
        agentHasLifecycleEvent &&
        isAgentReady(agentState)
      ) {
        setInitializationState("initialized");
      }
    }, [initializationState, isAgentTerminal, agentHasLifecycleEvent, agentState]);

    useEffect(() => {
      return () => {
        if (sendRafRef.current !== null) {
          cancelAnimationFrame(sendRafRef.current);
        }
      };
    }, []);

    const isInitializing = isAgentTerminal && initializationState === "initializing";

    useEffect(() => {
      setDraftInput(terminalId, value);
    }, [terminalId, value, setDraftInput]);

    useEffect(() => {
      return () => {
        if (sendRafRef.current !== null) {
          cancelAnimationFrame(sendRafRef.current);
          sendRafRef.current = null;
        }
      };
    }, []);

    const placeholder = useMemo(() => {
      const agentName = agentId ? getAgentConfig(agentId)?.name : null;
      if (isInitializing && agentName) {
        return `${agentName} is loading…`;
      }
      return agentName ? `Enter your command for ${agentName}…` : "Enter your command…";
    }, [agentId, isInitializing]);

    const activeMode = slashContext ? "command" : atContext ? "file" : null;
    const isAutocompleteOpen = activeMode !== null && !disabled;

    const { files: autocompleteFiles, isLoading: isAutocompleteLoading } = useFileAutocomplete({
      cwd,
      query: atContext?.queryForSearch ?? "",
      enabled: isAutocompleteOpen && activeMode === "file",
      limit: 50,
    });

    const { items: autocompleteCommands, isLoading: isCommandsLoading } =
      useSlashCommandAutocomplete({
        query: slashContext?.query ?? "",
        enabled: isAutocompleteOpen && activeMode === "command",
        agentId,
        projectPath: cwd,
      });

    const autocompleteItems = useMemo((): AutocompleteItem[] => {
      if (activeMode === "file") {
        return autocompleteFiles.map((file) => ({ key: file, label: file, value: file }));
      }
      if (activeMode === "command") {
        return autocompleteCommands;
      }
      return [];
    }, [activeMode, autocompleteCommands, autocompleteFiles]);

    const isLoading =
      activeMode === "file"
        ? isAutocompleteLoading
        : activeMode === "command"
          ? isCommandsLoading
          : false;

    const resizeTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
      if (!textarea) return;
      textarea.style.height = "auto";
      const nextHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX);
      textarea.style.height = `${nextHeight}px`;
    }, []);

    useLayoutEffect(() => {
      resizeTextarea(textareaRef.current);
    }, [resizeTextarea, value]);

    useLayoutEffect(() => {
      if (collapsedHeightPx !== null) return;
      const el = barContentRef.current;
      if (!el) return;
      if (value.length > 0) return;

      const rafId = requestAnimationFrame(() => {
        const next = Math.ceil(el.getBoundingClientRect().height);
        if (next > 0) setCollapsedHeightPx(next);
      });
      return () => cancelAnimationFrame(rafId);
    }, [collapsedHeightPx, value]);

    useLayoutEffect(() => {
      if (!isAutocompleteOpen) return;
      const textarea = textareaRef.current;
      const shell = inputShellRef.current;
      if (!textarea || !shell) return;

      const anchorIndex =
        activeMode === "file" ? atContext?.atStart : activeMode === "command" ? 0 : null;
      if (anchorIndex === null || anchorIndex === undefined) return;

      const compute = () => {
        const shellRect = shell.getBoundingClientRect();
        const textareaRect = textarea.getBoundingClientRect();
        const textareaOffsetLeft = textareaRect.left - shellRect.left;
        const markerLeft = getTextOffsetLeftPx(textarea, anchorIndex);

        const rawLeft = textareaOffsetLeft + markerLeft;
        const menuWidth = menuRef.current?.offsetWidth ?? 420;
        const maxLeft = Math.max(0, shell.clientWidth - menuWidth);
        const clampedLeft = Math.max(0, Math.min(rawLeft, maxLeft));
        setMenuLeftPx(clampedLeft);
      };

      compute();

      const onResize = () => compute();
      window.addEventListener("resize", onResize);
      const ro = new ResizeObserver(() => compute());
      ro.observe(shell);
      ro.observe(textarea);

      return () => {
        window.removeEventListener("resize", onResize);
        ro.disconnect();
      };
    }, [activeMode, atContext?.atStart, isAutocompleteOpen]);

    useEffect(() => {
      const activeQuery =
        activeMode === "file"
          ? `file:${atContext?.queryForSearch ?? ""}`
          : activeMode === "command"
            ? `command:${slashContext?.query ?? ""}`
            : "";

      if (activeQuery !== lastQueryRef.current) {
        lastQueryRef.current = activeQuery;
        setSelectedIndex(0);
      }
    }, [activeMode, atContext?.queryForSearch, slashContext?.query]);

    useEffect(() => {
      if (!isAutocompleteOpen) return;
      const root = rootRef.current;
      if (!root) return;

      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (root.contains(target)) return;
        setAtContext(null);
        setSlashContext(null);
      };

      document.addEventListener("pointerdown", onPointerDown, true);
      return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [isAutocompleteOpen]);

    useEffect(() => {
      if (!isAutocompleteOpen) return;
      if (autocompleteItems.length === 0) {
        setSelectedIndex(0);
        return;
      }
      setSelectedIndex((prev) => Math.max(0, Math.min(prev, autocompleteItems.length - 1)));
    }, [autocompleteItems.length, isAutocompleteOpen]);

    const sendFromTextarea = useCallback(() => {
      if (disabled || isInitializing) return;
      const text = textareaRef.current?.value ?? value;
      if (text.trim().length === 0) return;
      const payload = buildTerminalSendPayload(text);
      onSend({ data: payload.data, trackerData: payload.trackerData, text });
      addToHistory(terminalId, text);
      resetHistoryIndex(terminalId);
      setValue("");
      clearDraftInput(terminalId);
      setAtContext(null);
      setSlashContext(null);
      requestAnimationFrame(() => resizeTextarea(textareaRef.current));
    }, [
      addToHistory,
      disabled,
      isInitializing,
      onSend,
      resizeTextarea,
      resetHistoryIndex,
      value,
      clearDraftInput,
      terminalId,
    ]);

    const queueSend = useCallback(() => {
      if (sendRafRef.current !== null) return;
      sendRafRef.current = requestAnimationFrame(() => {
        sendRafRef.current = null;
        sendFromTextarea();
      });
    }, [sendFromTextarea]);

    const focusTextarea = useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      requestAnimationFrame(() => textarea.focus());
    }, []);

    const focusTextareaWithCursorAtEnd = useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      requestAnimationFrame(() => {
        // Verify element is still mounted and is the same instance
        if (textareaRef.current !== textarea || !textarea.isConnected) return;

        textarea.focus();
        const len = textarea.value.length;
        textarea.setSelectionRange(len, len);

        // For long multi-line drafts, ensure caret is visible
        if (textarea.scrollHeight > textarea.clientHeight) {
          textarea.scrollTop = textarea.scrollHeight;
        }
      });
    }, []);

    const handleHistoryNavigation = useCallback(
      (direction: "up" | "down"): boolean => {
        const result = navigateHistory(terminalId, direction, value);
        if (result !== null) {
          setValue(result);
          requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (textarea) {
              textarea.setSelectionRange(result.length, result.length);
              resizeTextarea(textarea);
            }
          });
          return true;
        }
        return false;
      },
      [navigateHistory, terminalId, value, resizeTextarea]
    );

    useImperativeHandle(
      ref,
      () => ({ focus: focusTextarea, focusWithCursorAtEnd: focusTextareaWithCursorAtEnd }),
      [focusTextarea, focusTextareaWithCursorAtEnd]
    );

    const handleKeyPassthrough = useCallback(
      (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (!onSendKey) return false;
        if (disabled) return false;
        if (isInitializing) return false;
        if (event.nativeEvent.isComposing) return false;

        const isEmpty = value.trim().length === 0;

        if (event.key === "Escape" && !isAutocompleteOpen) {
          event.preventDefault();
          event.stopPropagation();
          onSendKey("escape");
          return true;
        }

        const canNavigateHistory = isEmpty || isInHistoryMode;

        if (canNavigateHistory && event.key === "ArrowUp") {
          if (handleHistoryNavigation("up")) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          if (isEmpty) {
            event.preventDefault();
            event.stopPropagation();
            onSendKey("up");
            return true;
          }
        }

        if (canNavigateHistory && event.key === "ArrowDown") {
          if (handleHistoryNavigation("down")) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          if (isEmpty) {
            event.preventDefault();
            event.stopPropagation();
            onSendKey("down");
            return true;
          }
        }

        if (isEmpty) {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            onSendKey(event.key === "ArrowLeft" ? "left" : "right");
            return true;
          }

          const isEnter =
            event.key === "Enter" ||
            event.key === "Return" ||
            event.code === "Enter" ||
            event.code === "NumpadEnter";
          if (isEnter && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            onSendKey("enter");
            return true;
          }
        }

        if (
          (event.key === "c" || event.key === "C") &&
          event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          const textarea = textareaRef.current;
          const hasSelection =
            textarea && textarea.selectionStart !== null && textarea.selectionEnd !== null
              ? textarea.selectionStart !== textarea.selectionEnd
              : false;

          // Preserve copy when user has selected text inside the textarea.
          if (hasSelection) return false;

          event.preventDefault();
          event.stopPropagation();
          onSendKey("ctrl+c");
          return true;
        }

        return false;
      },
      [
        disabled,
        handleHistoryNavigation,
        isInHistoryMode,
        isInitializing,
        isAutocompleteOpen,
        onSendKey,
        value,
      ]
    );

    const refreshContextsFromTextarea = useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const caret = textarea.selectionStart ?? textarea.value.length;
      const text = textarea.value;

      const slash = getSlashCommandContext(text, caret);
      if (slash) {
        setSlashContext(slash);
        setAtContext(null);
        return;
      }

      setSlashContext(null);
      setAtContext(getAtFileContext(text, caret));
    }, []);

    const applyAutocompleteItem = useCallback(
      (item: AutocompleteItem, action: "insert" | "execute") => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const currentValue = textarea.value;
        const caret = textarea.selectionStart ?? currentValue.length;
        const slashCtx = getSlashCommandContext(currentValue, caret) ?? slashContext;

        if (activeMode === "file") {
          const ctx = getAtFileContext(currentValue, caret);
          if (!ctx) return;

          const token = `${formatAtFileToken(item.value)} `;
          const before = currentValue.slice(0, ctx.atStart);
          const after = currentValue.slice(ctx.tokenEnd);
          const nextValue = `${before}${token}${after}`;
          const nextCaret = before.length + token.length;

          if (action === "execute") {
            const payload = buildTerminalSendPayload(nextValue);
            onSend({ data: payload.data, trackerData: payload.trackerData, text: nextValue });
            addToHistory(terminalId, nextValue);
            resetHistoryIndex(terminalId);
            setValue("");
            setAtContext(null);
            setSlashContext(null);
            setSelectedIndex(0);
            lastQueryRef.current = "";
            requestAnimationFrame(() => resizeTextarea(textareaRef.current));
            return;
          }

          setValue(nextValue);
          setAtContext(null);
          setSlashContext(null);
          setSelectedIndex(0);
          lastQueryRef.current = "";

          requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(nextCaret, nextCaret);
            resizeTextarea(textarea);
          });
          return;
        }

        if (activeMode === "command" && slashCtx) {
          const before = currentValue.slice(0, slashCtx.start);
          const replaceEnd = Math.min(caret, slashCtx.tokenEnd);
          const after = currentValue.slice(replaceEnd);

          const hasLeadingSpace = after.startsWith(" ");
          const shouldAppendSpace = action === "insert" && !hasLeadingSpace;
          const token = shouldAppendSpace ? `${item.value} ` : item.value;
          const nextValue = `${before}${token}${after}`;
          const nextCaret =
            before.length + token.length + (action === "insert" && hasLeadingSpace ? 1 : 0);

          if (action === "execute") {
            const payload = buildTerminalSendPayload(nextValue);
            onSend({ data: payload.data, trackerData: payload.trackerData, text: nextValue });
            addToHistory(terminalId, nextValue);
            resetHistoryIndex(terminalId);
            setValue("");
            setAtContext(null);
            setSlashContext(null);
            setSelectedIndex(0);
            lastQueryRef.current = "";
            requestAnimationFrame(() => resizeTextarea(textareaRef.current));
            return;
          }

          setValue(nextValue);
          setAtContext(null);
          setSlashContext(null);
          setSelectedIndex(0);
          lastQueryRef.current = "";

          requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(nextCaret, nextCaret);
            resizeTextarea(textarea);
          });
        }
      },
      [
        activeMode,
        addToHistory,
        onSend,
        resizeTextarea,
        resetHistoryIndex,
        slashContext,
        terminalId,
      ]
    );

    const handleAutocompleteSelect = useCallback(
      (item: AutocompleteItem) => {
        if (activeMode === "command") {
          const idx = autocompleteItems.findIndex((i) => i.key === item.key);
          setSelectedIndex(idx >= 0 ? idx : 0);
          focusTextarea();
          return;
        }

        applyAutocompleteItem(item, "insert");
      },
      [activeMode, applyAutocompleteItem, autocompleteItems, focusTextarea]
    );

    const barContent = (
      <div ref={barContentRef} className="group cursor-text bg-canopy-bg px-4 pb-5 pt-4">
        <div className="flex items-end gap-2">
          <div
            ref={inputShellRef}
            className={cn(
              "relative",
              "flex w-full items-stretch gap-1.5 rounded-sm border border-white/[0.06] bg-white/[0.03] py-2 shadow-[0_6px_12px_rgba(0,0,0,0.18)] transition-colors",
              "group-hover:border-white/[0.08] group-hover:bg-white/[0.04]",
              "focus-within:border-white/[0.12] focus-within:ring-1 focus-within:ring-white/[0.06] focus-within:bg-white/[0.05]",
              disabled && "opacity-60",
              isInitializing && "opacity-50"
            )}
            aria-disabled={disabled || isInitializing}
          >
            <AutocompleteMenu
              ref={menuRef}
              isOpen={isAutocompleteOpen}
              items={autocompleteItems}
              selectedIndex={selectedIndex}
              isLoading={isLoading}
              onSelect={handleAutocompleteSelect}
              style={{ left: `${menuLeftPx}px` }}
              ariaLabel={activeMode === "command" ? "Command autocomplete" : "File autocomplete"}
            />

            <div className="select-none self-start pl-2 pr-1 font-mono text-xs font-semibold leading-5 text-canopy-accent/85">
              ❯
            </div>

            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                resizeTextarea(e.target);

                if (isInHistoryMode) {
                  resetHistoryIndex(terminalId);
                }

                const caret = e.target.selectionStart ?? e.target.value.length;
                const text = e.target.value;

                const slash = getSlashCommandContext(text, caret);
                if (slash) {
                  setSlashContext(slash);
                  setAtContext(null);
                  return;
                }

                setSlashContext(null);
                setAtContext(getAtFileContext(text, caret));
              }}
              onCompositionStart={() => {
                submitAfterCompositionRef.current = false;
              }}
              onCompositionEnd={() => {
                if (!submitAfterCompositionRef.current) return;
                submitAfterCompositionRef.current = false;
                queueSend();
              }}
              placeholder={placeholder}
              rows={1}
              spellCheck={false}
              className={cn(
                "flex-1 resize-none bg-transparent pr-1 font-mono text-xs leading-5 text-canopy-text",
                "placeholder:text-canopy-text/25 focus:outline-none disabled:opacity-50",
                "max-h-40 overflow-y-auto"
              )}
              disabled={disabled}
              onBlurCapture={(e) => {
                const nextTarget = e.relatedTarget as HTMLElement | null;
                const root = rootRef.current;
                if (root && nextTarget && root.contains(nextTarget)) return;
                setAtContext(null);
                setSlashContext(null);
                allowNextLineBreakRef.current = false;
                handledEnterRef.current = false;
                submitAfterCompositionRef.current = false;
                if (sendRafRef.current !== null) {
                  cancelAnimationFrame(sendRafRef.current);
                  sendRafRef.current = null;
                }
              }}
              onBeforeInput={(e) => {
                if (disabled) return;
                const nativeEvent = e.nativeEvent as InputEvent;
                if (!isEnterLikeLineBreakInputEvent(nativeEvent)) return;

                if (handledEnterRef.current) {
                  handledEnterRef.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }

                if (allowNextLineBreakRef.current) {
                  allowNextLineBreakRef.current = false;
                  return;
                }

                if (isInitializing) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }

                if (isAutocompleteOpen && autocompleteItems[selectedIndex]) {
                  e.preventDefault();
                  e.stopPropagation();
                  const action =
                    activeMode === "command" ? ("execute" as const) : ("insert" as const);
                  if (action === "execute" && isInitializing) {
                    return;
                  }
                  applyAutocompleteItem(autocompleteItems[selectedIndex], action);
                  return;
                }

                e.preventDefault();
                e.stopPropagation();
                if (nativeEvent.isComposing) {
                  submitAfterCompositionRef.current = true;
                  return;
                }
                queueSend();
              }}
              onKeyDownCapture={(e) => {
                if (disabled) return;
                const isEnter =
                  e.key === "Enter" ||
                  e.key === "Return" ||
                  e.code === "Enter" ||
                  e.code === "NumpadEnter";
                if (isEnter) {
                  allowNextLineBreakRef.current = e.shiftKey;
                }

                if (e.nativeEvent.isComposing) {
                  if (isEnter && !e.shiftKey) {
                    submitAfterCompositionRef.current = true;
                  }
                  return;
                }

                if (isAutocompleteOpen) {
                  const resultsCount = autocompleteItems.length;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setAtContext(null);
                    setSlashContext(null);
                    return;
                  }

                  if (resultsCount > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedIndex((prev) => {
                      if (resultsCount === 0) return 0;
                      if (e.key === "ArrowDown") return (prev + 1) % resultsCount;
                      return (prev - 1 + resultsCount) % resultsCount;
                    });
                    return;
                  }

                  if (resultsCount > 0 && e.key === "Tab") {
                    e.preventDefault();
                    e.stopPropagation();
                    applyAutocompleteItem(autocompleteItems[selectedIndex], "insert");
                    return;
                  }

                  if (resultsCount > 0 && e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    handledEnterRef.current = true;
                    setTimeout(() => {
                      handledEnterRef.current = false;
                    }, 0);
                    const action =
                      activeMode === "command" ? ("execute" as const) : ("insert" as const);
                    if (action === "execute" && isInitializing) {
                      return;
                    }
                    applyAutocompleteItem(autocompleteItems[selectedIndex], action);
                    return;
                  }
                }

                if (handleKeyPassthrough(e)) {
                  return;
                }

                if (isEnter) {
                  if (e.shiftKey) return;
                  if (isInitializing) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  handledEnterRef.current = true;
                  setTimeout(() => {
                    handledEnterRef.current = false;
                  }, 0);
                  queueSend();
                }
              }}
              onKeyUpCapture={() => {
                if (disabled) return;
                refreshContextsFromTextarea();
              }}
              onClick={() => {
                if (disabled) return;
                refreshContextsFromTextarea();
              }}
            />
          </div>
        </div>
      </div>
    );

    const isOverlayMode = collapsedHeightPx !== null;

    return (
      <div
        ref={rootRef}
        className={cn("relative w-full shrink-0", disabled && "pointer-events-none", className)}
        onPointerDownCapture={(e) => {
          if (disabled) return;
          if (e.button !== 0) return;
          onActivate?.();
          focusTextarea();
        }}
        onMouseDownCapture={(e) => {
          if (disabled) return;
          if (e.button !== 0) return;
          onActivate?.();
          focusTextarea();
        }}
        onClick={() => {
          if (disabled) return;
          onActivate?.();
          focusTextarea();
        }}
      >
        {isOverlayMode ? (
          <>
            <div aria-hidden="true" style={{ height: `${collapsedHeightPx}px` }} />
            <div className="absolute inset-x-0 bottom-0 z-10">{barContent}</div>
          </>
        ) : (
          barContent
        )}
      </div>
    );
  }
);

HybridInputBar.displayName = "HybridInputBar";
