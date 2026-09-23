import { EmojiPicker as EmojiPickerPrimitive } from "frimousse";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { POPOVER_SEARCH_INPUT_CLASS, POPOVER_SEARCH_STRIP_CLASS } from "./PopoverSearchField";
import { PALETTE_SECTION_LABEL_CLASS } from "./paletteRowStyles";
import { SkeletonBone } from "./Skeleton";

interface EmojiPickerProps {
  className?: string;
  onEmojiSelect: (emoji: { emoji: string; label: string }) => void;
  /** The value the caller holds now, marked in the grid and shown in the footer at rest. */
  currentEmoji?: string;
}

const SKELETON_ROWS = 7;

const CATEGORY_HEADER_CLASS = cn(
  PALETTE_SECTION_LABEL_CLASS,
  // Opaque, since it is sticky over scrolling rows, and the panel's own solid
  // tone so it never reads as a band.
  "bg-[var(--overlay-surface-solid)] px-3 pt-2.5 pb-1"
);
const COLUMNS = 9;

/**
 * Stored emoji and emojibase's disagree on the emoji presentation selector
 * (`☀️` vs `☀`), so the current value is matched with it stripped.
 */
function sameEmoji(a: string, b: string): boolean {
  return a.replace(/\uFE0F/g, "") === b.replace(/\uFE0F/g, "");
}

export function EmojiPicker({ className, onEmojiSelect, currentEmoji }: EmojiPickerProps) {
  return (
    <EmojiPickerPrimitive.Root
      className={cn("isolate flex h-[320px] w-[336px] flex-col", className)}
      onEmojiSelect={onEmojiSelect}
      emojibaseUrl="/emojibase"
      columns={COLUMNS}
    >
      {/* The house filtering-popover strip rather than a boxed field: it is
          autofocused in two of the three consumers, so an accent ring here would
          be chrome that is always lit. */}
      <label className={POPOVER_SEARCH_STRIP_CLASS}>
        <Search className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <EmojiPickerPrimitive.Search
          className={cn(
            POPOVER_SEARCH_INPUT_CLASS,
            // Escape already closes the popover; a second, heavier clear control
            // drawn by the engine was the loudest thing on the panel.
            "appearance-none [&::-webkit-search-cancel-button]:appearance-none"
          )}
          placeholder="Search emoji…"
        />
      </label>
      {/* Loading and Empty sit beside the viewport rather than inside it, so they
          centre on the panel and not on the viewport minus its scrollbar gutter. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Sized by the column rather than positioned: frimousse stamps
            `position: relative` inline on the viewport. */}
        <EmojiPickerPrimitive.Viewport className="min-h-0 flex-1 outline-hidden">
          <EmojiPickerPrimitive.List
            className="select-none pb-1.5"
            components={{
              CategoryHeader: ({ category, ...props }) => (
                <div className={CATEGORY_HEADER_CLASS} {...props}>
                  {category.label}
                </div>
              ),
              Row: ({ children, ...props }) => (
                // Leading inset on the panel's text column (the label, search
                // icon and footer glyph all start at px-3); the trailing side is
                // short by the scrollbar gutter frimousse reserves there.
                <div className="scroll-my-1.5 flex pl-3 pr-0.5" {...props}>
                  {children}
                </div>
              ),
              Emoji: ({ emoji, ...props }) => {
                const isCurrent =
                  currentEmoji !== undefined && sameEmoji(emoji.emoji, currentEmoji);
                return (
                  <button
                    type="button"
                    aria-current={isCurrent ? "true" : undefined}
                    className={cn(
                      "relative flex h-8 w-1/9 min-w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-lg leading-none transition-colors",
                      // Pointer and arrow keys drive the same `data-active`, and
                      // Enter acts on it. The raised fill alone clears about
                      // 1.1-1.3:1, so the neutral outline carries the 3:1 — the
                      // menu rows' highlighted treatment, and it survives forced
                      // colours where the fill is stripped.
                      "data-[active]:bg-overlay-raised data-[active]:outline-solid data-[active]:outline-2 data-[active]:outline-selection-outline data-[active]:outline-offset-[-2px]"
                    )}
                    {...props}
                  >
                    {emoji.emoji}
                    {isCurrent && (
                      <span
                        aria-hidden="true"
                        // Tucked into the cell's corner, clear of the glyph, and cut
                        // out of it by a ring of the panel's own tone.
                        className="absolute right-0 bottom-0 flex size-3 items-center justify-center rounded-full bg-text-primary text-[var(--overlay-surface-solid)] ring-2 ring-[var(--overlay-surface-solid)]"
                      >
                        <Check className="size-2" strokeWidth={4} />
                      </span>
                    )}
                  </button>
                );
              },
            }}
          />
        </EmojiPickerPrimitive.Viewport>
        {/* Laid out on the grid's own column so nothing moves when the data lands. */}
        <EmojiPickerPrimitive.Loading className="absolute inset-0 flex flex-col">
          <span className="sr-only">Loading emoji</span>
          {/* The category header's own box, holding a line of text height, so the
              rows below start exactly where the real ones will. */}
          <span aria-hidden="true" className={cn(CATEGORY_HEADER_CLASS, "flex items-center")}>
            <SkeletonBone className="h-2 w-24 rounded-full" />
            {"\u00A0"}
          </span>
          {Array.from({ length: SKELETON_ROWS }, (_, row) => (
            <span key={row} aria-hidden="true" className="flex pl-3 pr-3">
              {Array.from({ length: COLUMNS }, (_, col) => (
                <span key={col} className="flex h-8 w-1/9 shrink-0 items-center justify-center">
                  <SkeletonBone className="size-5 rounded-full" />
                </span>
              ))}
            </span>
          ))}
        </EmojiPickerPrimitive.Loading>
        <EmojiPickerPrimitive.Empty className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
          {({ search }) => (
            <>
              <span className="text-sm text-text-primary">No emoji match “{search}”</span>
              <span className="text-xs text-text-secondary">Try a shorter or different word</span>
            </>
          )}
        </EmojiPickerPrimitive.Empty>
      </div>
      <EmojiPickerPrimitive.ActiveEmoji>
        {({ emoji }) => (
          // Fixed height: the preview glyph is taller than a line of text, and a
          // footer that grew on hover shrank the grid above it.
          <div className="flex h-11 shrink-0 items-center gap-2 border-t border-border-default px-3 text-sm">
            {emoji ? (
              <>
                <span className="text-xl leading-none">{emoji.emoji}</span>
                <span className="truncate text-text-primary">{emoji.label}</span>
              </>
            ) : currentEmoji ? (
              <>
                <span className="text-xl leading-none">{currentEmoji}</span>
                <span className="truncate text-text-secondary">Current icon</span>
              </>
            ) : (
              <span className="text-text-secondary">Pick an emoji</span>
            )}
          </div>
        )}
      </EmojiPickerPrimitive.ActiveEmoji>
    </EmojiPickerPrimitive.Root>
  );
}
