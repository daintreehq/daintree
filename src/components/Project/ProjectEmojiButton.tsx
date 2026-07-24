import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { cn } from "@/lib/utils";

interface ProjectEmojiButtonProps {
  emoji: string;
  onEmojiChange: (emoji: string) => void;
  disabled?: boolean;
  /** Accessible label — say which project or field the emoji belongs to. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Emoji swatch that opens the full picker in a popover. Same interaction as the
 * project-settings identity block, sized for an inline dialog row.
 */
export function ProjectEmojiButton({
  emoji,
  onEmojiChange,
  disabled = false,
  ariaLabel = "Choose project emoji",
  className,
}: ProjectEmojiButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]",
            "border border-daintree-border bg-muted/50 text-lg leading-none",
            "transition-colors hover:bg-muted disabled:opacity-50",
            "focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 focus:border-daintree-accent",
            className
          )}
        >
          <span className="select-none">{emoji}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <EmojiPicker
          onEmojiSelect={({ emoji: picked }) => {
            onEmojiChange(picked);
            setIsOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
