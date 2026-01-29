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

    const canSubmit = value.trim().length > 0 && !disabled;

    return (
      <div className={cn("border-t border-canopy-border bg-canopy-bg px-4 py-3", className)}>
        <div
          className={cn(
            "flex items-end gap-2.5 rounded-lg border bg-canopy-sidebar/20 px-3.5 py-2.5",
            "border-canopy-border/60",
            "transition-all duration-150",
            "focus-within:border-canopy-accent/60 focus-within:bg-canopy-sidebar/30 focus-within:ring-1 focus-within:ring-canopy-accent/20",
            disabled && "opacity-50"
          )}
        >
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
              "flex-1 bg-transparent text-canopy-text text-sm leading-relaxed",
              "resize-none outline-none",
              "placeholder:text-canopy-text/40",
              "disabled:cursor-not-allowed"
            )}
            aria-label="Message input"
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={cn(
              "p-2 rounded-md shrink-0",
              canSubmit
                ? "bg-canopy-accent text-white hover:bg-canopy-accent/90"
                : "bg-canopy-sidebar/50 text-canopy-text/30",
              "disabled:cursor-not-allowed",
              "transition-all duration-150",
              "focus:outline-none focus:ring-2 focus:ring-canopy-accent/50"
            )}
            aria-label="Send message"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center justify-between mt-2 px-1 text-[10px] text-canopy-text/40">
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-canopy-sidebar/60 font-mono border border-canopy-border/40">
              ⏎
            </kbd>
            <span>to send</span>
            <span className="mx-1.5 text-canopy-text/20">•</span>
            <kbd className="px-1.5 py-0.5 rounded bg-canopy-sidebar/60 font-mono border border-canopy-border/40">
              ⇧⏎
            </kbd>
            <span>new line</span>
          </span>
          <span className="text-canopy-text/30">
            <kbd className="px-1.5 py-0.5 rounded bg-canopy-sidebar/60 font-mono border border-canopy-border/40">
              ⌘⇧K
            </kbd>
            <span className="ml-1">focus</span>
          </span>
        </div>
      </div>
    );
  }
);

AssistantInput.displayName = "AssistantInput";
