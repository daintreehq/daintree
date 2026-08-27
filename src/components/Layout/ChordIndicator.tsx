import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useCommandHud, type CommandHudItem } from "@/hooks/useCommandHud";

const LIST_ID = "command-hud-listbox";
const OPTION_ID_PREFIX = "command-hud-option";

/**
 * Persistent, searchable command HUD anchored bottom-center. Opened by the
 * Cmd+K chord (`useCommandHud` derives `isOpen` from the pending chord); it
 * lists the curated Cmd+K power-command layer grouped by category, each with
 * its Cmd+‹letter› shortcut, filters as you type, and runs the selected command
 * on Enter/click. Modifier-held keys still complete chords while it's open —
 * that routing lives in useGlobalKeybindings.
 */
export function ChordIndicator() {
  const {
    isOpen,
    query,
    setQuery,
    results,
    groups,
    selectedIndex,
    setSelectedIndex,
    selectNext,
    selectPrevious,
    run,
    runSelected,
    close,
  } = useCommandHud();

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // Set when a command is run (not on Esc/outside-close) so focus restoration
  // never fights an action that intentionally moved focus elsewhere.
  const skipRestoreRef = useRef(false);

  const restoreFocus = useCallback(() => {
    const skip = skipRestoreRef.current;
    skipRestoreRef.current = false;
    const el = previousFocusRef.current;
    previousFocusRef.current = null;
    if (skip || !el) return;
    // If focus already moved to something meaningful — e.g. a modal palette that
    // a completed chord (Cmd+K then Cmd+O) opened and focused — don't yank it
    // back to the pre-HUD target. Only restore when focus is loose (on body) or
    // still inside the closing HUD, which is the Esc / toggle-close case.
    const active = document.activeElement;
    if (active && active !== document.body && rootRef.current?.contains(active) !== true) return;
    if (document.contains(el)) el.focus();
  }, []);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen,
    onAnimateOut: restoreFocus,
  });

  // Capture the pre-HUD focus target, then move focus into the search input.
  useEffect(() => {
    if (!isOpen) return;
    skipRestoreRef.current = false;
    const active = document.activeElement;
    if (active instanceof HTMLElement && rootRef.current?.contains(active) !== true) {
      previousFocusRef.current = active;
    }
    // Focus synchronously (not via rAF) so the input owns the very next keystroke
    // — otherwise a fast key typed right after Cmd+K lands before focus arrives
    // and gets consumed as an invalid chord key, closing the HUD.
    inputRef.current?.focus();
  }, [isOpen]);

  // Close on any click outside the HUD (capture phase, before the target's own
  // handlers). Row clicks run/close via their own onClick before this fires.
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        // The click itself moves focus to whatever was clicked — don't fight it
        // by restoring the pre-HUD focus (Esc / 2nd Cmd+K still restore).
        skipRestoreRef.current = true;
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [isOpen, close]);

  // Keep the selected row scrolled into view under arrow navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-hud-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [selectedIndex, results]);

  // Per-group starting offset into the flat `results` list, so each row can map
  // to its selection index without mutating a counter during render.
  const groupOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const group of groups) {
      offsets.push(acc);
      acc += group.items.length;
    }
    return offsets;
  }, [groups]);

  const runItem = useCallback(
    (item: CommandHudItem) => {
      skipRestoreRef.current = true;
      run(item);
    },
    [run]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          selectNext();
          break;
        case "ArrowUp":
          e.preventDefault();
          selectPrevious();
          break;
        case "Enter":
          e.preventDefault();
          skipRestoreRef.current = true;
          runSelected();
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
      }
    },
    [selectNext, selectPrevious, runSelected, close]
  );

  if (!shouldRender) return null;

  const activeDescendant =
    results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
      ? `${OPTION_ID_PREFIX}-${results[selectedIndex]!.actionId}`
      : undefined;

  return createPortal(
    <div
      ref={rootRef}
      data-command-hud=""
      className={cn(
        "fixed bottom-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)]",
        "w-[min(34rem,calc(100vw-2rem))]",
        "transition-opacity duration-150",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "opacity-100" : "opacity-0"
      )}
    >
      <div
        className={cn(
          // Dark-glass "spotlight" panel: a frosted, translucent surface that
          // floats above the terminals so the Cmd+K layer reads as its own
          // command mode rather than a standard overlay. Blur/saturation come
          // from the theme material tokens; `command-hud-glass` carries the
          // solid fallback under performance-mode / forced-colors (index.css).
          "command-hud-glass rounded-[var(--radius-lg)] overflow-hidden",
          "border border-[var(--border-overlay)]",
          "backdrop-blur-2xl backdrop-saturate-[var(--theme-material-saturation)]",
          "transition duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-[0.96]"
        )}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          aria-label="Search commands"
          aria-activedescendant={activeDescendant}
          placeholder="Search commands…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className={cn(
            "w-full bg-transparent px-4 py-2.5 text-sm",
            "text-text-primary placeholder:text-text-placeholder",
            "focus:outline-hidden"
          )}
        />

        <div
          ref={listRef}
          id={LIST_ID}
          role="listbox"
          aria-label="Commands"
          className="border-t border-[var(--border-overlay)] px-2 py-2 max-h-[22rem] overflow-y-auto"
        >
          {results.length === 0 ? (
            <div className="px-2 py-3 text-xs text-text-secondary">No commands match</div>
          ) : (
            groups.map((group, groupIdx) => (
              <div key={group.category}>
                {groupIdx > 0 && <div className="border-t border-[var(--border-overlay)] my-1.5" />}
                <div
                  className="text-3xs font-medium uppercase tracking-wider text-daintree-text/30 px-1 py-1"
                  role="presentation"
                >
                  {group.category}
                </div>
                {group.items.map((item, itemIdx) => {
                  const index = groupOffsets[groupIdx]! + itemIdx;
                  const isSelected = index === selectedIndex;
                  return (
                    <div
                      key={item.actionId}
                      id={`${OPTION_ID_PREFIX}-${item.actionId}`}
                      role="option"
                      aria-selected={isSelected}
                      data-hud-index={index}
                      onClick={() => runItem(item)}
                      onMouseMove={() => setSelectedIndex(index)}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] px-2 py-1 text-xs",
                        "transition-colors duration-150 motion-reduce:transition-none",
                        isSelected && "bg-overlay-subtle"
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-daintree-text/80">
                        {item.description}
                      </span>
                      {item.displayKey ? (
                        <kbd className="shrink-0 font-medium text-daintree-text/50 tracking-wide">
                          {item.displayKey}
                        </kbd>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--border-overlay)] px-4 py-1.5 text-2xs text-text-secondary select-none">
          <span>↑↓ select</span>
          <span aria-hidden className="text-daintree-text/20">
            ·
          </span>
          <span>⏎ run</span>
          <span aria-hidden className="text-daintree-text/20">
            ·
          </span>
          <span>esc close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
