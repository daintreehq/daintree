import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { getUiPaletteTransitionDuration, UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useCommandHud, type CommandHudItem } from "@/hooks/useCommandHud";
import { COMMAND_HUD_PREFIX } from "@/hooks/useGlobalKeybindings";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { KbdChord } from "@/components/ui/Kbd";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";

const LIST_ID = "command-hud-listbox";
const OPTION_ID_PREFIX = "command-hud-option";
const GROUP_ID_PREFIX = "command-hud-group";
const PREFIX_DESCRIPTION_ID = "command-hud-prefix";

/**
 * Persistent, searchable command HUD anchored bottom-center. Opened by the
 * Cmd+K chord (`useCommandHud` derives `isOpen` from the pending chord); it
 * shows the pending prefix, lists the curated Cmd+K power-command layer grouped
 * by category with each command's second key, filters as you type, and runs the
 * selected command on Enter/click. Modifier-held keys still complete chords
 * while it's open — that routing lives in useGlobalKeybindings.
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
  // Set only by a pointer press outside the HUD: the click itself moves focus to
  // whatever was clicked, so restoring the pre-HUD target would fight it.
  const skipRestoreRef = useRef(false);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen,
    animationDuration: getUiPaletteTransitionDuration("exit"),
  });

  // Capture the pre-HUD focus target on open, and hand focus back the moment
  // the chord ends — not after the exit fade, so a key pressed right after
  // Escape lands where the user was working instead of on a retiring input.
  //
  // The capture is a layout effect declared ahead of the focus effect below, so
  // it reads the invoker before the input takes focus — including a reopen
  // inside the exit fade, when the panel is already mounted and the focus
  // effect would otherwise run first and leave nothing to return to.
  const wasOpenRef = useRef(false);
  useLayoutEffect(() => {
    if (!isOpen) return;
    wasOpenRef.current = true;
    skipRestoreRef.current = false;
    const active = document.activeElement;
    if (active instanceof HTMLElement && rootRef.current?.contains(active) !== true) {
      previousFocusRef.current = active;
    }
  }, [isOpen]);
  useEffect(() => {
    if (isOpen || !wasOpenRef.current) return;
    wasOpenRef.current = false;
    const skip = skipRestoreRef.current;
    skipRestoreRef.current = false;
    const el = previousFocusRef.current;
    previousFocusRef.current = null;
    if (skip || !el) return;
    // If focus already moved to something meaningful — e.g. a modal a completed
    // chord opened and focused — don't yank it back. Only restore when focus is
    // loose (on body) or still inside the closing HUD: Esc, the Cmd+K toggle, or
    // a command that left focus where it was.
    const active = document.activeElement;
    if (active && active !== document.body && rootRef.current?.contains(active) !== true) return;
    if (document.contains(el)) el.focus();
  }, [isOpen]);

  // Focus the input once it is actually mounted. `isOpen` flips a commit before
  // `useAnimatedPresence` renders the HUD, so keying on `isOpen` alone focused a
  // null ref and typed keys went nowhere. Layout effect, so the input owns the
  // very next keystroke rather than the one after the next paint.
  useLayoutEffect(() => {
    if (isOpen && shouldRender) inputRef.current?.focus();
  }, [isOpen, shouldRender]);

  // Close on any click outside the HUD (capture phase, before the target's own
  // handlers). Row clicks run/close via their own onClick before this fires.
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
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

  // Announce the match count once typing settles. Empty queries are skipped (the
  // full layer is what opened), and so are zero matches — the empty state carries
  // its own live region.
  const resultCount = results.length;
  useEffect(() => {
    if (!isOpen || !query.trim() || resultCount === 0) return;
    const timer = window.setTimeout(() => {
      const noun = resultCount === 1 ? "command" : "commands";
      useAnnouncerStore.getState().announce(`${resultCount} ${noun}`, "polite");
    }, UI_DOHERTY_THRESHOLD);
    return () => window.clearTimeout(timer);
  }, [isOpen, query, resultCount]);

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

  const runItem = useCallback((item: CommandHudItem) => run(item), [run]);

  // Focus leaving the input ends the chord. Without this, Tab (or any script
  // focus) left the chord pending with nothing on screen owning the keyboard,
  // and the open-gap guard in useGlobalKeybindings swallowed every printable
  // key from then on. The destination keeps its focus; a blur to nowhere
  // (focus falling to body, or the window losing focus — which
  // useGlobalKeybindings also treats as a cancel) restores the invoker like
  // Escape does.
  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      if (!isOpen) return;
      const next = e.relatedTarget;
      if (next instanceof Node && rootRef.current?.contains(next) === true) return;
      if (next) skipRestoreRef.current = true;
      close();
    },
    [isOpen, close]
  );

  // Pressing the panel's own chrome (a heading, the footer, the gap between
  // rows) would otherwise move focus to body and end the chord through the
  // blur above. Rows still run on click; only the focus move is prevented.
  const keepInputFocus = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== inputRef.current) e.preventDefault();
  }, []);

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
  const prefixLabel = isMac() ? "⌘K" : "Ctrl+K";

  return createPortal(
    <div
      ref={rootRef}
      data-command-hud=""
      // The retiring HUD is still painted through its exit fade; nothing in it
      // may take a click or focus once the chord has ended.
      inert={!isOpen}
      className={cn(
        "fixed bottom-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)]",
        "w-[min(34rem,calc(100vw-2rem))]"
      )}
    >
      <div
        onMouseDown={keepInputFocus}
        className={cn(
          // Frosted "spotlight" panel floating over the terminals so the Cmd+K
          // layer reads as its own command mode rather than a standard overlay.
          // Blur/saturation come from the theme material tokens; the tint and
          // every solid fallback live on `command-hud-glass` in index.css.
          "command-hud-glass rounded-[var(--radius-lg)] overflow-hidden",
          "border border-[var(--border-overlay)]",
          "backdrop-blur-2xl backdrop-saturate-[var(--theme-material-saturation)]",
          "transition-[opacity,translate,scale]",
          isVisible ? "duration-150 ease-out" : "duration-100 ease-in",
          "reduce-motion:transition-none reduce-motion:translate-none reduce-motion:scale-none",
          isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-[0.96]"
        )}
      >
        <div className="flex items-center gap-2 px-4 py-2.5">
          <span id={PREFIX_DESCRIPTION_ID} className="sr-only">
            {`${prefixLabel} pressed. Press the next key, or search.`}
          </span>
          <span aria-hidden="true" className="shrink-0" data-command-hud-prefix="">
            <KbdChord shortcut={COMMAND_HUD_PREFIX} />
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-label="Search commands"
            aria-describedby={PREFIX_DESCRIPTION_ID}
            aria-activedescendant={activeDescendant}
            placeholder="Next key, or search commands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className={cn(
              "min-w-0 flex-1 bg-transparent text-sm",
              // Secondary, not the family's placeholder token: this placeholder
              // is the instruction ("Next key, or search…"), not a label for an
              // empty field, and the placeholder token has no contrast floor.
              "text-text-primary placeholder:text-text-secondary",
              "focus:outline-hidden"
            )}
          />
        </div>

        <div
          ref={listRef}
          id={LIST_ID}
          role="listbox"
          aria-label="Commands"
          className="border-t border-[var(--border-overlay)] px-2 py-2 max-h-[22rem] overflow-y-auto"
        >
          {results.length === 0 ? (
            <AppPaletteDialog.Empty query={query} emptyMessage="No commands available" />
          ) : (
            groups.map((group, groupIdx) => {
              const groupId = `${GROUP_ID_PREFIX}-${groupIdx}`;
              return (
                <div key={group.category} role="group" aria-labelledby={groupId}>
                  {groupIdx > 0 && (
                    <div
                      role="presentation"
                      className="-mx-2 my-1.5 border-t border-[var(--border-overlay)]"
                    />
                  )}
                  <div
                    id={groupId}
                    role="presentation"
                    className={cn(PALETTE_SECTION_LABEL_CLASS, "ms-px px-2 py-1")}
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
                        aria-disabled={item.enabled ? undefined : true}
                        data-hud-index={index}
                        onClick={() => runItem(item)}
                        onMouseMove={() => setSelectedIndex(index)}
                        className={cn(
                          PALETTE_ROW_CLASS,
                          "group flex cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] px-2 py-1 text-xs",
                          "duration-150 reduce-motion:transition-none"
                        )}
                      >
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span
                            className={cn(
                              "min-w-0 shrink truncate",
                              item.enabled ? "text-text-primary" : "text-text-secondary"
                            )}
                          >
                            {item.description}
                          </span>
                          {item.disabledReason && (
                            <span className="min-w-0 flex-1 truncate text-2xs text-text-secondary italic">
                              {item.disabledReason}
                            </span>
                          )}
                        </span>
                        <KbdChord
                          shortcut={item.combo}
                          density="bare"
                          aria-label={item.displayKey}
                          // The row lifts its label to primary text when
                          // selected; the key follows, or it sits under the
                          // 4.5:1 floor on the raised fill over bright content.
                          className="shrink-0 group-aria-selected:[&_kbd]:text-text-primary"
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* The family's footer rule: name what Enter does for the current
            selection, and draw no band when nothing selected can run. Arrows and
            Esc are conventions the surface doesn't restate. Not
            `AppPaletteDialog.Footer`, whose solid panel fill would cut a
            band out of the glass. */}
        {results[selectedIndex]?.enabled === true && (
          <div className="border-t border-[var(--border-overlay)] px-4 py-2 text-xs text-text-secondary select-none">
            <PaletteFooterHints primaryHint={{ keys: ["↵"], label: "to run command" }} />
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
