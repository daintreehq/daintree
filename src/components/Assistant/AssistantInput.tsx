import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
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
  (
    {
      onSubmit,
      disabled = false,
      placeholder = "Execute a command or ask a question...",
      className,
    },
    ref
  ) => {
    const [value, setValue] = useState("");
    const [isComposing, setIsComposing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const hintId = useId();

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
      <div className={cn("shrink-0 border-t border-divider bg-canopy-bg", className)}>
        <div
          className={cn(
            "relative flex items-start gap-2 px-3 py-3",
            disabled && "opacity-60 pointer-events-none"
          )}
        >
          <div className="shrink-0 pt-1.5 text-canopy-accent" aria-hidden="true">
            <span className="font-mono text-lg leading-none">›</span>
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
              "flex-1 max-h-[200px] min-h-[24px] resize-none bg-transparent py-1 text-sm text-canopy-text",
              "placeholder:text-canopy-text/30 focus:outline-none scrollbar-none font-mono"
            )}
            aria-label="Command input"
            aria-describedby={hintId}
          />

          <div className="shrink-0 pt-1" aria-hidden="true">
            <span
              className={cn(
                "text-[10px] border rounded px-1.5 py-0.5 transition-colors",
                canSubmit
                  ? "text-canopy-accent/70 border-canopy-accent/30"
                  : "text-canopy-text/30 border-divider"
              )}
            >
              ⏎ Run
            </span>
          </div>
        </div>

        <div id={hintId} className="px-3 pb-2 text-[10px] text-canopy-text/30">
          <kbd className="px-1 py-0.5 bg-canopy-sidebar/40 rounded font-mono">⇧⏎</kbd>
          <span className="ml-1">new line</span>
        </div>
      </div>
    );
  }
);

AssistantInput.displayName = "AssistantInput";
