import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { buildTerminalSendPayload } from "@/lib/terminalInput";

const MAX_TEXTAREA_HEIGHT_PX = 160;

export interface HybridInputBarHandle {
  focus: () => void;
}

export interface HybridInputBarProps {
  onSend: (payload: { data: string; trackerData: string; text: string }) => void;
  disabled?: boolean;
  className?: string;
}

export const HybridInputBar = forwardRef<HybridInputBarHandle, HybridInputBarProps>(
  ({ onSend, disabled = false, className }, ref) => {
    const [value, setValue] = useState("");
    const [isComposing, setIsComposing] = useState(false);
    const allowNextLineBreakRef = useRef(false);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const canSend = useMemo(() => value.trim().length > 0 && !disabled, [disabled, value]);

    const resizeTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
      if (!textarea) return;
      textarea.style.height = "auto";
      const nextHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX);
      textarea.style.height = `${nextHeight}px`;
    }, []);

    const send = useCallback(() => {
      if (!canSend) return;
      const payload = buildTerminalSendPayload(value);
      // Pass raw 'value' as 'text' so the backend handles formatting/bracketing cleanly
      onSend({ data: payload.data, trackerData: payload.trackerData, text: value });
      setValue("");
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

    return (
      <div
        className={cn(
          "shrink-0 cursor-text border-t border-white/5 bg-[var(--color-surface)] px-2 pb-1.5 pt-2",
          className
        )}
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
        <div className="flex items-end gap-2">
          <div
            className={cn(
              "flex w-full items-start gap-1.5 rounded-sm border border-white/5 bg-white/[0.03] transition-colors",
              "focus-within:border-canopy-accent/30 focus-within:bg-white/[0.05]",
              disabled && "opacity-60"
            )}
            aria-disabled={disabled}
          >
            <div className="select-none pl-2 pr-1 pt-1 font-mono text-xs font-semibold leading-5 text-canopy-accent/85">
              ❯
            </div>

            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                resizeTextarea(e.target);
              }}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              placeholder="Command…"
              rows={1}
              spellCheck={false}
              className={cn(
                "min-h-[28px] flex-1 resize-none bg-transparent py-1 pr-2 font-mono text-xs leading-5 text-canopy-text",
                "placeholder:text-canopy-text/25 focus:outline-none disabled:opacity-50",
                "max-h-40 overflow-y-auto"
              )}
              disabled={disabled}
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
            />
          </div>
        </div>

        <div className="mt-1 flex items-center justify-end px-[2px]">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={send}
            disabled={!canSend}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-mono font-medium transition-colors",
              "border-white/10 bg-white/[0.02] text-canopy-text/60 hover:border-white/20 hover:bg-white/[0.05] hover:text-canopy-text",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/35",
              "cursor-pointer disabled:cursor-default disabled:opacity-40 disabled:hover:bg-white/[0.02] disabled:hover:text-canopy-text/60"
            )}
            aria-label="Send (Enter)"
            title="Send (Enter)"
          >
            <span className="text-[12px] leading-none text-canopy-text/70" aria-hidden="true">
              ↵
            </span>
            <span>Send</span>
          </button>
        </div>
      </div>
    );
  }
);

HybridInputBar.displayName = "HybridInputBar";
