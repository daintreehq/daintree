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
      <div className={cn("shrink-0 cursor-text bg-canopy-sidebar/20", className)}>
        <div
          className={cn(
            "flex items-start gap-2 px-3 py-2",
            disabled && !isStreaming && "opacity-60 pointer-events-none"
          )}
          onClick={handleContainerClick}
        >
          <div
            className="shrink-0 pt-1.5 select-none font-mono text-lg text-canopy-text/40"
            aria-hidden="true"
          >
            ›
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
              "flex-1 max-h-[200px] min-h-[24px] resize-none bg-transparent text-sm text-canopy-text pt-1",
              "placeholder:text-canopy-text/30 focus:outline-none scrollbar-none font-mono"
            )}
            aria-label="Command input"
            aria-keyshortcuts="Enter Shift+Enter"
          />

          {isStreaming && onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className={cn(
                "shrink-0 mt-0.5 p-1.5 rounded transition-colors",
                "text-red-400 hover:bg-red-500/10"
              )}
              aria-label="Cancel response"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            canSubmit && (
              <button
                type="button"
                onClick={handleSubmit}
                className={cn(
                  "shrink-0 mt-0.5 p-1.5 rounded transition-colors",
                  "text-canopy-accent hover:bg-canopy-accent/10"
                )}
                aria-label="Submit"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            )
          )}
        </div>

        <div className="px-3 pb-1 text-[10px] text-canopy-text/20">
          <kbd className="font-mono">⇧⏎</kbd> newline
        </div>
      </div>
    );
  }
);

AssistantInput.displayName = "AssistantInput";
