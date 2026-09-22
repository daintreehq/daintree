import { useCallback, useLayoutEffect, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { useResizeObserverRaf } from "@/hooks/useResizeObserverRaf";

/**
 * The share of the shell's width the icon column may take before the trailing
 * controls stop sharing the canvas's row.
 *
 * This is the rule that actually decides it, and it is proportional on
 * purpose. What the column costs is not the characters it removes but the
 * hole it leaves to the right of every line above the last: in an 1800px pane
 * a 36px column is invisible, at 950px a 60px one is a visible rag, at 430px
 * it is a seventh of the width. Every Layout's Sidebar stacks on the same
 * kind of ratio. With the column measured (buttons plus its gap and inset), a
 * second or third button raises the crossover on its own: roughly 600px with
 * the paperclip alone, 1000px with the mic, 1400px with the stash as well.
 */
export const COMPOSER_RAIL_COLUMN_FRACTION = 0.06;

/**
 * A floor for large fonts, in characters: whatever the ratio says, stack once
 * the icon column would push the line's measure below this. Bringhurst's floor
 * for a comfortable line, and where the usability literature on multi-line
 * text entry lands. At the default font size the ratio rule fires first at
 * every width; this only matters when the terminal font is large enough that
 * a pane the ratio calls wide still holds few characters.
 */
export const COMPOSER_RAIL_MEASURE_CH = 45;

/**
 * Inline spacing beside the trailing group that goes with it when it leaves
 * the row: the shell's `gap-x-1.5` before it and the wrapper's `pr-1.5`.
 * Part of the column's cost, so part of the ratio.
 */
const COLUMN_GUTTER_PX = 6 + 6;

/**
 * Inline spacing the canvas does not get beyond the picker and the column:
 * the gutter after the picker and the editor's own 4px right inset
 * (`.cm-content` in `inputEditorExtensions`). Constants of the markup rather
 * than measured, so a font change cannot move them.
 */
const INLINE_CHROME_PX = 6 + 4;

/** Character width before the editor has mounted; JetBrains Mono at 13px. */
const FALLBACK_CHAR_WIDTH_PX = 7.8;

interface UseComposerMeasureParams {
  editorViewRef: React.RefObject<EditorView | null>;
  inputShellRef: React.RefObject<HTMLDivElement | null>;
  pickerRef: React.RefObject<HTMLButtonElement | null>;
  trailingGroupRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Decides whether the composer is too narrow for its trailing controls to
 * share the canvas's row, and publishes that as `data-composer-narrow` on the
 * shell.
 *
 * The rule is the icon column's share of the shell width
 * (`COMPOSER_RAIL_COLUMN_FRACTION`), with the line measure
 * (`COMPOSER_RAIL_MEASURE_CH`) as a floor. Both are computed from measured
 * widths, so a third trailing button raises the crossover on its own. The
 * canvas is set in `--text-xs` rather than the terminal font, so the
 * character width is effectively a constant; it is read from the editor when
 * one is mounted only so the floor stays honest if that ever changes.
 *
 * Everything measured here is invariant to the decision it feeds. The shell's
 * width does not depend on which row the icons occupy, and the trailing group
 * that is measured is the content-sized inner cluster, never the wrapper —
 * the wrapper takes a full basis on the rail, so its width would be the whole
 * row and "narrow" would confirm itself. Measuring against the resulting line
 * count is what produced the feedback loop the wrap marker's latch exists to
 * break; this hook is careful not to reintroduce it from the other side.
 *
 * Only the shell and the inner group are observed. Both outlive the editor,
 * which `useEditorFactory` replaces when the terminal changes; an observer on
 * the editor's DOM would keep watching the destroyed one.
 *
 * Presence attribute, so the CSS reads `[data-composer-narrow]` and never has
 * to reason about a `"false"` value.
 */
export function useComposerMeasure({
  editorViewRef,
  inputShellRef,
  pickerRef,
  trailingGroupRef,
}: UseComposerMeasureParams): void {
  const [shellEl, setShellEl] = useState<HTMLDivElement | null>(null);
  const [trailingEl, setTrailingEl] = useState<HTMLDivElement | null>(null);

  // Both elements are rendered on the first commit, so a single read after
  // layout is enough to start observing them; the RAF pass is a guard against
  // a ref that attaches a frame late. Same pattern as
  // `useAutocompletePositioning`.
  useLayoutEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;

    const sync = () => {
      if (cancelled) return;
      const nextShell = inputShellRef.current;
      const nextTrailing = trailingGroupRef.current;
      setShellEl((current) => (current === nextShell ? current : nextShell));
      setTrailingEl((current) => (current === nextTrailing ? current : nextTrailing));
    };

    sync();
    rafId = requestAnimationFrame(sync);

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [inputShellRef, trailingGroupRef]);

  const measure = useCallback(() => {
    const shell = inputShellRef.current;
    const picker = pickerRef.current;
    const trailing = trailingGroupRef.current;
    if (!shell || !picker || !trailing) return;

    const charWidth = editorViewRef.current?.defaultCharacterWidth || FALLBACK_CHAR_WIDTH_PX;
    const column = trailing.offsetWidth + COLUMN_GUTTER_PX;
    const inlineTextWidth = shell.clientWidth - picker.offsetWidth - column - INLINE_CHROME_PX;
    const narrow =
      column / shell.clientWidth > COMPOSER_RAIL_COLUMN_FRACTION ||
      inlineTextWidth / charWidth < COMPOSER_RAIL_MEASURE_CH;

    const current = shell.hasAttribute("data-composer-narrow");
    if (narrow === current) return;
    if (narrow) shell.setAttribute("data-composer-narrow", "true");
    else shell.removeAttribute("data-composer-narrow");
  }, [editorViewRef, inputShellRef, pickerRef, trailingGroupRef]);

  useResizeObserverRaf(shellEl, measure);
  useResizeObserverRaf(trailingEl, measure);

  useLayoutEffect(() => {
    measure();
  }, [measure, shellEl, trailingEl]);
}
