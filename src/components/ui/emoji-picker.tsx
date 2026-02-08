import { EmojiPicker as EmojiPickerPrimitive } from "frimousse";
import { cn } from "@/lib/utils";

interface EmojiPickerProps {
  className?: string;
  onEmojiSelect: (emoji: { emoji: string; label: string }) => void;
}

export function EmojiPicker({ className, onEmojiSelect }: EmojiPickerProps) {
  return (
    <EmojiPickerPrimitive.Root
      className={cn("isolate flex h-[320px] w-[320px] flex-col", className)}
      onEmojiSelect={onEmojiSelect}
      emojibaseUrl="/emojibase"
    >
      <EmojiPickerPrimitive.Search
        className="z-10 mx-2 mt-2 appearance-none rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border px-3 py-2 text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
        placeholder="Search emojis..."
      />
      <EmojiPickerPrimitive.Viewport className="relative flex-1 outline-hidden">
        <EmojiPickerPrimitive.Loading className="absolute inset-0 flex items-center justify-center text-canopy-text/60 text-sm">
          Loading…
        </EmojiPickerPrimitive.Loading>
        <EmojiPickerPrimitive.Empty className="absolute inset-0 flex items-center justify-center text-canopy-text/60 text-sm">
          No emoji found.
        </EmojiPickerPrimitive.Empty>
        <EmojiPickerPrimitive.List
          className="select-none pb-1.5"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                className="bg-canopy-sidebar px-3 pt-3 pb-1.5 font-medium text-canopy-text/60 text-xs"
                {...props}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div className="scroll-my-1.5 px-1.5" {...props}>
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-[var(--radius-md)] text-lg transition-colors hover:bg-canopy-border data-[active]:bg-canopy-border"
                {...props}
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </EmojiPickerPrimitive.Viewport>
      <EmojiPickerPrimitive.ActiveEmoji>
        {({ emoji }) => (
          <div className="flex items-center gap-2 px-3 py-2 border-t border-canopy-border text-sm text-canopy-text/60 min-h-[40px]">
            {emoji ? (
              <>
                <span className="text-xl">{emoji.emoji}</span>
                <span className="truncate">{emoji.label}</span>
              </>
            ) : (
              <span>Select an emoji…</span>
            )}
          </div>
        )}
      </EmojiPickerPrimitive.ActiveEmoji>
    </EmojiPickerPrimitive.Root>
  );
}
