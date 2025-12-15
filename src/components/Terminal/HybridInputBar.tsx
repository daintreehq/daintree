import {
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
import { AutocompleteMenu, type AutocompleteItem } from "./AutocompleteMenu";
import {
  formatAtFileToken,
  getAtFileContext,
  getSlashCommandContext,
  type AtFileContext,
  type SlashCommandContext,
} from "./hybridInputParsing";

const MAX_TEXTAREA_HEIGHT_PX = 160;

export interface HybridInputBarHandle {
  focus: () => void;
}

export interface HybridInputBarProps {
  onSend: (payload: { data: string; trackerData: string; text: string }) => void;
  cwd: string;
  agentId?: LegacyAgentType;
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
  ({ onSend, cwd, agentId, disabled = false, className }, ref) => {
    const [value, setValue] = useState("");
    const [isComposing, setIsComposing] = useState(false);
    const allowNextLineBreakRef = useRef(false);
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

    const canSend = useMemo(() => value.trim().length > 0 && !disabled, [disabled, value]);

    const placeholder = useMemo(() => {
      const agentName = agentId ? getAgentConfig(agentId)?.name : null;
      return agentName ? `Enter your command for ${agentName}…` : "Enter your command…";
    }, [agentId]);

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

    const send = useCallback(() => {
      if (!canSend) return;
      const payload = buildTerminalSendPayload(value);
      // Pass raw 'value' as 'text' so the backend handles formatting/bracketing cleanly
      onSend({ data: payload.data, trackerData: payload.trackerData, text: value });
      setValue("");
      setAtContext(null);
      setSlashContext(null);
      requestAnimationFrame(() => resizeTextarea(textareaRef.current));
    }, [canSend, onSend, value, resizeTextarea]);

    const focusTextarea = useCallback(() => {
      if (disabled) return;
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      requestAnimationFrame(() => textarea.focus());
    }, [disabled]);

    useImperativeHandle(ref, () => ({ focus: focusTextarea }), [focusTextarea]);

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

        const caret = textarea.selectionStart ?? value.length;
        const slashCtx = getSlashCommandContext(value, caret) ?? slashContext;

        if (activeMode === "file") {
          const ctx = getAtFileContext(value, caret);
          if (!ctx) return;

          const token = `${formatAtFileToken(item.value)} `;
          const before = value.slice(0, ctx.atStart);
          const after = value.slice(ctx.tokenEnd);
          const nextValue = `${before}${token}${after}`;
          const nextCaret = before.length + token.length;

          if (action === "execute") {
            const payload = buildTerminalSendPayload(nextValue);
            onSend({ data: payload.data, trackerData: payload.trackerData, text: nextValue });
            setValue("");
            setAtContext(null);
            setSlashContext(null);
            setSelectedIndex(0);
            requestAnimationFrame(() => resizeTextarea(textareaRef.current));
            return;
          }

          setValue(nextValue);
          setAtContext(null);
          setSlashContext(null);
          setSelectedIndex(0);

          requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(nextCaret, nextCaret);
            resizeTextarea(textarea);
          });
          return;
        }

        if (activeMode === "command" && slashCtx) {
          const before = value.slice(0, slashCtx.start);
          const after = value.slice(slashCtx.tokenEnd);

          const shouldAppendSpace = action === "insert" && !after.startsWith(" ");
          const token = shouldAppendSpace ? `${item.value} ` : item.value;
          const nextValue = `${before}${token}${after}`;
          const nextCaret = before.length + token.length;

          if (action === "execute") {
            const payload = buildTerminalSendPayload(nextValue);
            onSend({ data: payload.data, trackerData: payload.trackerData, text: nextValue });
            setValue("");
            setAtContext(null);
            setSlashContext(null);
            setSelectedIndex(0);
            requestAnimationFrame(() => resizeTextarea(textareaRef.current));
            return;
          }

          setValue(nextValue);
          setAtContext(null);
          setSlashContext(null);
          setSelectedIndex(0);

          requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(nextCaret, nextCaret);
            resizeTextarea(textarea);
          });
        }
      },
      [activeMode, onSend, resizeTextarea, slashContext, value]
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
      <div ref={barContentRef} className="cursor-text bg-canopy-bg px-4 pb-5 pt-4">
        <div className="flex items-end gap-2">
          <div
            ref={inputShellRef}
            className={cn(
              "relative",
              "flex w-full items-stretch gap-1.5 rounded-sm border border-canopy-border bg-white/[0.03] py-2 shadow-[0_8px_10px_rgba(0,0,0,0.25)] transition-colors",
              "focus-within:border-canopy-accent/30 focus-within:bg-white/[0.05]",
              disabled && "opacity-60"
            )}
            aria-disabled={disabled}
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
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              placeholder={placeholder}
              rows={1}
              spellCheck={false}
              className={cn(
                "flex-1 resize-none bg-transparent pr-1 font-mono text-sm leading-5 text-canopy-text",
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
              }}
              onBeforeInput={(e) => {
                if (disabled) return;
                if (isComposing) return;
                const nativeEvent = e.nativeEvent as InputEvent;
                if (nativeEvent.isComposing) return;
                if (
                  nativeEvent.inputType !== "insertLineBreak" &&
                  nativeEvent.inputType !== "insertParagraph"
                ) {
                  return;
                }

                if (isAutocompleteOpen && autocompleteItems[selectedIndex]) {
                  if (allowNextLineBreakRef.current) {
                    allowNextLineBreakRef.current = false;
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  const action =
                    activeMode === "command" ? ("execute" as const) : ("insert" as const);
                  applyAutocompleteItem(autocompleteItems[selectedIndex], action);
                  return;
                }

                if (allowNextLineBreakRef.current) {
                  allowNextLineBreakRef.current = false;
                  return;
                }

                e.preventDefault();
                e.stopPropagation();
                send();
              }}
              onKeyDownCapture={(e) => {
                if (disabled) return;
                if (isComposing || e.nativeEvent.isComposing) return;

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
                    const action =
                      activeMode === "command" ? ("execute" as const) : ("insert" as const);
                    applyAutocompleteItem(autocompleteItems[selectedIndex], action);
                    return;
                  }
                }

                const isEnter =
                  e.key === "Enter" ||
                  e.key === "Return" ||
                  e.code === "Enter" ||
                  e.code === "NumpadEnter";
                if (isEnter && e.shiftKey) {
                  allowNextLineBreakRef.current = true;
                  return;
                }
                allowNextLineBreakRef.current = false;
                if (isEnter) {
                  e.preventDefault();
                  e.stopPropagation();
                  send();
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
        className={cn("relative shrink-0", className)}
        onPointerDownCapture={(e) => {
          if (disabled) return;
          if (e.button !== 0) return;
          focusTextarea();
        }}
        onMouseDownCapture={(e) => {
          if (e.button !== 0) return;
          focusTextarea();
        }}
        onClick={() => {
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
