import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AssistantInputHandle {
  focus: () => void;
  clear: () => void;
}

interface AssistantInputProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export const AssistantInput = forwardRef<AssistantInputHandle, AssistantInputProps>(
  ({ onSubmit, disabled = false, placeholder = "Ask the assistant...", className }, ref) => {
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
        if (e.key === "Enter" && !e.shiftKey && !isComposing) {
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

    const canSubmit = value.trim().length > 0 && !disabled;

    return (
      <div className={cn("border-t border-canopy-border bg-canopy-bg px-4 py-3", className)}>
        <div
          className={cn(
            "flex items-end gap-2 rounded-md border bg-canopy-sidebar/30 px-3 py-2",
            "border-canopy-border/50",
            "transition-colors",
            "focus-within:border-canopy-accent/50 focus-within:ring-1 focus-within:ring-canopy-accent/20",
            disabled && "opacity-50"
          )}
        >
          <span className="text-canopy-accent/80 font-mono text-sm font-semibold pb-0.5">›</span>
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
              "flex-1 bg-transparent text-canopy-text text-sm",
              "resize-none outline-none",
              "placeholder:text-canopy-text/30",
              "disabled:cursor-not-allowed"
            )}
            aria-label="Message input"
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={cn(
              "p-1.5 rounded",
              "text-canopy-accent hover:bg-canopy-accent/10",
              "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent",
              "transition-colors",
              "focus:outline-none focus:ring-1 focus:ring-canopy-accent/50"
            )}
            aria-label="Send message"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center justify-between mt-1.5 px-1 text-[10px] text-canopy-text/30">
          <span>
            <kbd className="px-1 py-0.5 rounded bg-canopy-sidebar/50 font-mono">Enter</kbd>
            <span className="ml-1">to send</span>
            <span className="mx-2">•</span>
            <kbd className="px-1 py-0.5 rounded bg-canopy-sidebar/50 font-mono">Shift+Enter</kbd>
            <span className="ml-1">for new line</span>
          </span>
          <span>Cmd+Shift+K to focus</span>
        </div>
      </div>
    );
  }
);

AssistantInput.displayName = "AssistantInput";
