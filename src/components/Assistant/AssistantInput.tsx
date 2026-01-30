import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AssistantInputHandle {
  focus: () => void;
  clear: () => void;
}

interface AssistantInputProps {
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export const AssistantInput = forwardRef<AssistantInputHandle, AssistantInputProps>(
  (
    {
      onSubmit,
      onCancel,
      isStreaming = false,
      disabled = false,
      placeholder = "Execute a command or ask a question...",
      className,
    },
    ref
  ) => {
    const [value, setValue] = useState("");
    const [isComposing, setIsComposing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const adjustHeight = useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      textarea.style.height = "auto";
      const scrollHeight = textarea.scrollHeight;
      const maxHeight = 200;
      textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
    }, []);

    useEffect(() => {
      adjustHeight();
    }, [value, adjustHeight]);

    const handleSubmit = useCallback(() => {
      const trimmed = value.trim();
      if (!trimmed || disabled) return;

      onSubmit(trimmed);
      setValue("");
    }, [value, disabled, onSubmit]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey && !isComposing && !e.nativeEvent.isComposing) {
          e.preventDefault();
          handleSubmit();
        }
      },
      [handleSubmit, isComposing]
    );

    const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
    }, []);

    const handleCompositionStart = useCallback(() => {
      setIsComposing(true);
    }, []);

    const handleCompositionEnd = useCallback(() => {
      setIsComposing(false);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        clear: () => setValue(""),
      }),
      []
    );

    const handleContainerClick = useCallback(() => {
      textareaRef.current?.focus();
    }, []);

    const canSubmit = value.trim().length > 0 && !disabled;

    return (
      <div
        className={cn("group shrink-0 cursor-text bg-canopy-bg px-4 pb-3 pt-3", className)}
        onClick={handleContainerClick}
      >
        <div className="flex items-end gap-2">
          <div
            className={cn(
              "relative flex w-full items-center gap-1.5 rounded-sm border border-white/[0.06] bg-white/[0.03] py-1 shadow-[0_6px_12px_rgba(0,0,0,0.18)] transition-colors",
              "group-hover:border-white/[0.08] group-hover:bg-white/[0.04]",
              "focus-within:border-white/[0.12] focus-within:ring-1 focus-within:ring-white/[0.06] focus-within:bg-white/[0.05]",
              disabled && !isStreaming && "opacity-60"
            )}
            aria-disabled={disabled && !isStreaming}
          >
            <div className="select-none pl-2 pr-1 font-mono text-xs font-semibold leading-5 text-canopy-accent/85">
              ❯
            </div>

            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              className={cn(
                "flex-1 max-h-[200px] min-h-[20px] resize-none bg-transparent text-xs leading-5 text-canopy-text py-0.5",
                "placeholder:text-white/25 focus:outline-none scrollbar-none"
              )}
              style={{ fontFamily: "var(--font-mono, monospace)" }}
              aria-label="Command input"
              aria-keyshortcuts="Enter Shift+Enter"
            />

            {isStreaming && onCancel ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel();
                }}
                className={cn(
                  "shrink-0 mr-1.5 p-1 rounded transition-colors",
                  "text-red-400 hover:bg-red-500/10"
                )}
                aria-label="Cancel response"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
            ) : (
              canSubmit && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSubmit();
                  }}
                  className={cn(
                    "shrink-0 mr-1.5 p-1 rounded transition-colors",
                    "text-canopy-accent hover:bg-canopy-accent/10"
                  )}
                  aria-label="Submit"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
              )
            )}
          </div>
        </div>
      </div>
    );
  }
);

AssistantInput.displayName = "AssistantInput";
