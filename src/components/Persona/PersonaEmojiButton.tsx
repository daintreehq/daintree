import { useState } from "react";
import { SmilePlus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface PersonaEmojiButtonProps {
  /** The emoji worn now; absent when none. */
  emoji: string | undefined;
  /** The chosen emoji, or undefined when it is cleared. */
  onEmojiChange: (emoji: string | undefined) => void;
  /** Says whose emoji this is, e.g. "Global assistant emoji". */
  ariaLabel: string;
  disabled?: boolean;
  /** The row's description and error, so a failed save is read with the button. */
  describedBy?: string;
  invalid?: boolean;
  className?: string;
}

/**
 * A persona's optional emoji (#16213): the project emoji swatch's interaction,
 * with an empty state and a way back to none, which a project's required emoji
 * never needs.
 */
export function PersonaEmojiButton({
  emoji,
  onEmojiChange,
  ariaLabel,
  disabled = false,
  describedBy,
  invalid = false,
  className,
}: PersonaEmojiButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${ariaLabel}, ${emoji ? `currently ${emoji}` : "none"}`}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          data-testid="persona-emoji-button"
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]",
            "border border-border-default bg-overlay-subtle text-base leading-none",
            "transition-colors hover:bg-overlay-soft data-[state=open]:bg-overlay-soft disabled:opacity-50",
            "focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
            className
          )}
        >
          {emoji ? (
            <span className="select-none">{emoji}</span>
          ) : (
            <SmilePlus className="h-4 w-4 text-text-secondary" aria-hidden="true" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" aria-label={ariaLabel}>
        <EmojiPicker
          currentEmoji={emoji}
          onEmojiSelect={({ emoji: picked }) => {
            onEmojiChange(picked);
            setIsOpen(false);
          }}
        />
        {emoji && (
          <div className="flex justify-end border-t border-border-subtle p-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onEmojiChange(undefined);
                setIsOpen(false);
              }}
            >
              Clear emoji
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
